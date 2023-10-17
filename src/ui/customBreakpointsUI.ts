/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as vscode from 'vscode';
import {
  CustomBreakpointId,
  customBreakpoints,
  ICustomBreakpoint,
} from '../adapter/customBreakpoints';
import { Commands, CustomViews } from '../common/contributionUtils';
import { EventEmitter } from '../common/events';
import { DebugSessionTracker } from './debugSessionTracker';

class Breakpoint extends vscode.TreeItem {
  id: CustomBreakpointId;

  constructor(cb: ICustomBreakpoint, enabled: boolean) {
    super(cb.title, vscode.TreeItemCollapsibleState.None);
    this.checkboxState = enabled
      ? vscode.TreeItemCheckboxState.Checked
      : vscode.TreeItemCheckboxState.Unchecked;
    this.id = cb.id;
  }

  static compare(a: Breakpoint, b: Breakpoint) {
    return a.id.localeCompare(b.id);
  }
}

class BreakpointCategory extends vscode.TreeItem {
  group: string;
  children: Breakpoint[];

  constructor(public readonly label: string) {
    super(label, vscode.TreeItemCollapsibleState.Collapsed);
    this.children = [];
    this.group = label;
    this.checkboxState = { state: vscode.TreeItemCheckboxState.Unchecked };
  }

  static compare(a: BreakpointCategory, b: BreakpointCategory) {
    return a.group.localeCompare(b.group);
  }
}

class BreakpointsDataProvider implements vscode.TreeDataProvider<Breakpoint | BreakpointCategory> {
  private _onDidChangeTreeData = new EventEmitter<BreakpointCategory | Breakpoint | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private _debugSessionTracker: DebugSessionTracker;

  breakpointCategories: BreakpointCategory[];

  constructor(debugSessionTracker: DebugSessionTracker) {
    this.breakpointCategories = [];
    for (const cb of customBreakpoints().values()) {
      if (cb.group) {
        const existing = this.breakpointCategories.find(b => b.group === cb.group);
        if (!existing) {
          this.breakpointCategories.push(new BreakpointCategory(cb.group));
        }
      }

      this.breakpointCategories
        .find(b => b.group === cb.group)
        ?.children.push(new Breakpoint(cb, false));
    }

    this._debugSessionTracker = debugSessionTracker;
    debugSessionTracker.onSessionAdded(session => {
      if (!DebugSessionTracker.isConcreteSession(session)) {
        return;
      }

      session.customRequest('enableCustomBreakpoints', {
        ids: this.breakpointCategories
          .map(bC =>
            bC.children.filter(b => b.checkboxState == vscode.TreeItemCheckboxState.Checked),
          )
          .flat(),
      });
    });
  }

  getTreeItem(item: Breakpoint | BreakpointCategory): vscode.TreeItem {
    return item;
  }

  getChildren(
    item?: Breakpoint | BreakpointCategory,
  ): vscode.ProviderResult<(BreakpointCategory | Breakpoint)[]> {
    if (!item) return this.breakpointCategories.sort(BreakpointCategory.compare);
    if (item instanceof BreakpointCategory) {
      return item.children.sort(Breakpoint.compare);
    }
    return [];
  }

  getParent(item: Breakpoint | BreakpointCategory): vscode.ProviderResult<BreakpointCategory> {
    if (item instanceof Breakpoint) {
      return this.breakpointCategories.find(b => b.group === item.label);
    }
    return undefined;
  }

  addBreakpoints(breakpoints: Breakpoint[]) {
    if (breakpoints.length == 0) return;

    for (const breakpoint of breakpoints)
      breakpoint.checkboxState = vscode.TreeItemCheckboxState.Checked;
    const ids = breakpoints.map(b => b.id);
    for (const session of this._debugSessionTracker.getConcreteSessions())
      session.customRequest('enableCustomBreakpoints', { ids });

    this.fixCheckState();
    this._onDidChangeTreeData.fire(undefined);
  }

  removeBreakpoints(breakpoints: Breakpoint[]) {
    if (breakpoints.length == 0) return;

    for (const bC of this.breakpointCategories) {
      if (bC.children.some(b => breakpoints.includes(b))) {
        bC.checkboxState = vscode.TreeItemCheckboxState.Unchecked;
      }
    }

    // disable every breakpoint in breakpoints
    for (const breakpoint of breakpoints)
      breakpoint.checkboxState = vscode.TreeItemCheckboxState.Unchecked;

    for (const session of this._debugSessionTracker.getConcreteSessions())
      session.customRequest('disableCustomBreakpoints', { ids: breakpoints.map(e => e.id) });

    this.fixCheckState();

    this._onDidChangeTreeData.fire(undefined);
  }

  fixCheckState() {
    // make sure if a group breakpoint is checked, all its children are checked
    // also make sure that if all of the children of a group are checked, the group is checked

    for (const breakpoint of this.breakpointCategories) {
      if (breakpoint.checkboxState == vscode.TreeItemCheckboxState.Checked) {
        for (const child of breakpoint.children) {
          child.checkboxState = vscode.TreeItemCheckboxState.Checked;
        }
      }

      if (breakpoint.children.every(b => b.checkboxState == vscode.TreeItemCheckboxState.Checked)) {
        breakpoint.checkboxState = vscode.TreeItemCheckboxState.Checked;
      }
    }

    this._onDidChangeTreeData.fire(undefined);
  }
}

export function registerCustomBreakpointsUI(
  context: vscode.ExtensionContext,
  debugSessionTracker: DebugSessionTracker,
) {
  const provider = new BreakpointsDataProvider(debugSessionTracker);

  const view = vscode.window.createTreeView(CustomViews.EventListenerBreakpoints, {
    treeDataProvider: provider,
    showCollapseAll: true,
    manageCheckboxStateManually: true,
  });

  view.onDidChangeCheckboxState(e => {
    if (e.items.length == 1 && e.items[0][0] instanceof BreakpointCategory) {
      if (e.items[0][1]) {
        provider.addBreakpoints(e.items[0][0].children);
      } else {
        provider.removeBreakpoints(e.items[0][0].children);
      }
      return;
    }

    for (const item of e.items) {
      if (item[0] instanceof Breakpoint) {
        if (item[1]) {
          provider.addBreakpoints([item[0]]);
        } else {
          provider.removeBreakpoints([item[0]]);
        }
      }
    }
  });

  context.subscriptions.push(view);

  context.subscriptions.push(
    vscode.commands.registerCommand(Commands.AddCustomBreakpoints, () => {
      const items = provider.breakpointCategories
        .sort(BreakpointCategory.compare)
        .map(bC => bC.children.map(b => ({ id: b.id, label: `${bC.label}: ${b.label}` })))
        .flat();
      vscode.window
        .showQuickPick(items, {
          canPickMany: true,
          placeHolder: 'Select breakpoints to enable',
        })
        .then(items => {
          if (!items) return;
          const ids = items.map(item => item.id);

          provider.addBreakpoints(
            provider.breakpointCategories
              .map(b => b.children)
              .flat()
              .filter(b => ids.includes(b.id)),
          );
        });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(Commands.RemoveAllCustomBreakpoints, () => {
      provider.removeBreakpoints(
        provider.breakpointCategories
          .filter(b => b.checkboxState == vscode.TreeItemCheckboxState.Checked)
          .map(e => e.children)
          .flat(),
      );
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(Commands.RemoveCustomBreakpoints, () => {
      const items = provider.breakpointCategories
        .sort(BreakpointCategory.compare)
        .map(bC => bC.children.map(b => ({ id: b.id, label: `${bC.label}: ${b.label}` })))
        .flat();
      vscode.window
        .showQuickPick(items, {
          canPickMany: true,
          placeHolder: 'Select breakpoints to disable',
        })
        .then(items => {
          if (!items) return;
          const ids = items.map(item => item.id);
          provider.removeBreakpoints(
            provider.breakpointCategories
              .map(b => b.children)
              .flat()
              .filter(b => ids.includes(b.id)),
          );
        });
    }),
  );
}
