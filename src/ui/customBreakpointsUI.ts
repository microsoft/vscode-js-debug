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
  group: string;

  constructor(cb: ICustomBreakpoint, enabled: boolean) {
    super(cb.title, vscode.TreeItemCollapsibleState.None);
    this.checkboxState = enabled
      ? vscode.TreeItemCheckboxState.Checked
      : vscode.TreeItemCheckboxState.Unchecked;
    this.id = cb.id;
    this.group = cb.group;
  }

  static compare(a: Breakpoint, b: Breakpoint) {
    return a.id.localeCompare(b.id);
  }
}

class BreakpointsDataProvider implements vscode.TreeDataProvider<Breakpoint | vscode.TreeItem> {
  private _onDidChangeTreeData = new EventEmitter<Breakpoint | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private _debugSessionTracker: DebugSessionTracker;

  breakpoints: Map<string, Breakpoint[]>;

  constructor(debugSessionTracker: DebugSessionTracker) {
    this.breakpoints = new Map<string, Breakpoint[]>(
      [...customBreakpoints()].reduce((acc, cb) => {
        if (![...acc.keys()].includes(cb[1].group)) acc.set(cb[1].group, []);

        acc.get(cb[1].group)?.push(new Breakpoint(cb[1], false));
        return acc;
      }, new Map<string, Breakpoint[]>()),
    );

    this._debugSessionTracker = debugSessionTracker;
    debugSessionTracker.onSessionAdded(session => {
      if (!DebugSessionTracker.isConcreteSession(session)) {
        return;
      }

      session.customRequest('enableCustomBreakpoints', {
        ids: this.getAllBreakpoints()
          .filter(b => b.checkboxState)
          .map(b => b.id),
      });
    });
  }

  getAllBreakpoints(): Breakpoint[] {
    return [...this.breakpoints.values()].flat();
  }
  getTreeItem(item: Breakpoint): vscode.TreeItem {
    return item;
  }

  getChildren(
    item?: vscode.TreeItem | Breakpoint,
  ): vscode.ProviderResult<(Breakpoint | vscode.TreeItem)[]> {
    if (!item)
      return [...this.breakpoints.keys()].map(key => {
        const retVal = new vscode.TreeItem(key, vscode.TreeItemCollapsibleState.Collapsed);
        retVal.checkboxState = this.breakpoints.get(key)?.every(p => p.checkboxState) ? 1 : 0;
        return retVal;
      });
    if ('label' in item) {
      if (item.label == undefined) return [];
      return this.breakpoints.get(item.label.toString());
    }
    return [];
  }

  getParent(item: Breakpoint): vscode.ProviderResult<Breakpoint> {
    if (item instanceof Breakpoint) {
      return this.getAllBreakpoints().find(b => b.group == item.label);
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

    this._onDidChangeTreeData.fire(undefined);
  }

  removeBreakpoints(breakpoints: Breakpoint[]) {
    if (breakpoints.length == 0) return;

    // disable every breakpoint in breakpoints
    for (const breakpoint of breakpoints)
      breakpoint.checkboxState = vscode.TreeItemCheckboxState.Unchecked;

    for (const session of this._debugSessionTracker.getConcreteSessions())
      session.customRequest('disableCustomBreakpoints', { ids: breakpoints.map(e => e.id) });

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
  });

  view.onDidChangeCheckboxState(e => {
    if (e.items.length == 1 && e.items[0][0] instanceof vscode.TreeItem) {
      if (!e.items[0][0].label) return;
      const allBr = provider.breakpoints.get(e.items[0][0].label.toString());
      if (!allBr) return;
      if (e.items[0][1]) {
        provider.addBreakpoints(allBr);
      } else {
        provider.removeBreakpoints(allBr);
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
      const items: (vscode.QuickPickItem & { id: CustomBreakpointId })[] = [
        ...provider.breakpoints.entries(),
      ]
        .map(bC => [
          { kind: vscode.QuickPickItemKind.Separator, id: bC[0], label: bC[0] },
          ...bC[1].map(b => ({ id: b.id, label: `${b.label}` })),
        ])
        .flat();
      vscode.window
        .showQuickPick(items, {
          canPickMany: true,
          placeHolder: 'Select breakpoints to enable',
        })
        .then(items => {
          if (!items) return;
          const ids = items
            .filter(item => item.kind != vscode.QuickPickItemKind.Separator)
            .map(item => item.id);

          provider.addBreakpoints(provider.getAllBreakpoints().filter(b => ids.includes(b.id)));
        });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(Commands.RemoveAllCustomBreakpoints, () => {
      provider.removeBreakpoints(provider.getAllBreakpoints());
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(Commands.RemoveCustomBreakpoints, () => {
      const items: (vscode.QuickPickItem & { id: CustomBreakpointId })[] = [
        ...provider.breakpoints.entries(),
      ]
        .map(bC => [
          { kind: vscode.QuickPickItemKind.Separator, id: bC[0], label: bC[0] },
          ...bC[1].map(b => ({ id: b.id, label: `${b.label}` })),
        ])
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
            [...provider.breakpoints]
              .map(b => b[1])
              .flat()
              .filter(b => ids.includes(b.id)),
          );
        });
    }),
  );
}
