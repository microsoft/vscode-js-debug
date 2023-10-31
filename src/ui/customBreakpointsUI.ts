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

  public get checked() {
    return this.checkboxState === vscode.TreeItemCheckboxState.Checked;
  }

  constructor(cb: ICustomBreakpoint, public readonly parent: Category) {
    super(cb.title, vscode.TreeItemCollapsibleState.None);
    this.checkboxState = vscode.TreeItemCheckboxState.Unchecked;
    this.id = cb.id;
    this.group = cb.group;
  }

  static compare(a: Breakpoint, b: Breakpoint) {
    return a.id.localeCompare(b.id);
  }
}

class Category extends vscode.TreeItem {
  public readonly children: Breakpoint[] = [];

  public get checked() {
    return this.checkboxState === vscode.TreeItemCheckboxState.Checked;
  }

  constructor(public readonly label: string) {
    super(label, vscode.TreeItemCollapsibleState.Collapsed);
    this.checkboxState = vscode.TreeItemCheckboxState.Unchecked;
  }
}

class BreakpointsDataProvider implements vscode.TreeDataProvider<Breakpoint | Category> {
  private _onDidChangeTreeData = new EventEmitter<Breakpoint | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private _debugSessionTracker: DebugSessionTracker;

  private readonly categories = new Map<string, Category>();

  /** Gets all breakpoint categories */
  public get allCategories() {
    return this.categories.values();
  }

  /** Gets all custom breakpoints */
  public get allBreakpoints() {
    return [...this.allCategories].flatMap(c => c.children);
  }

  constructor(debugSessionTracker: DebugSessionTracker) {
    for (const breakpoint of [...customBreakpoints().values()]) {
      let category = this.categories.get(breakpoint.group);
      if (!category) {
        category = new Category(breakpoint.group);
        this.categories.set(breakpoint.group, category);
      }
      category.children.push(new Breakpoint(breakpoint, category));
    }

    this._debugSessionTracker = debugSessionTracker;
    debugSessionTracker.onSessionAdded(session => {
      if (!DebugSessionTracker.isConcreteSession(session)) {
        return;
      }

      const toEnable = this.allBreakpoints.filter(b => b.checked).map(b => b.id);
      if (toEnable.length === 0) {
        return;
      }

      session.customRequest('setCustomBreakpoints', { ids: toEnable });
    });
  }

  /** @inheritdoc */
  getTreeItem(item: Breakpoint | Category): vscode.TreeItem {
    return item;
  }

  /** @inheritdoc */
  getChildren(item?: Breakpoint | Category): vscode.ProviderResult<(Breakpoint | Category)[]> {
    if (!item) {
      return [...this.categories.values()];
    }

    if (item instanceof Category) {
      return this.categories.get(item.label)?.children;
    }

    return [];
  }

  /** @inheritdoc */
  getParent(item: Breakpoint | Category): vscode.ProviderResult<Breakpoint | Category> {
    if (item instanceof Breakpoint) {
      return this.categories.get(item.group);
    }

    return undefined;
  }

  /** Updates the enablement state of the breakpoints/categories */
  public setEnabled(breakpoints: [Breakpoint | Category, boolean][]) {
    for (const [breakpoint, enabled] of breakpoints) {
      const state = enabled
        ? vscode.TreeItemCheckboxState.Checked
        : vscode.TreeItemCheckboxState.Unchecked;

      breakpoint.checkboxState = state;

      if (breakpoint instanceof Category) {
        for (const child of breakpoint.children) {
          if (child.checkboxState !== state) {
            child.checkboxState = state;
          }
        }
      } else {
        if (!enabled && breakpoint.parent.checked) {
          breakpoint.parent.checkboxState = state;
        } else if (enabled && breakpoint.parent.children.every(c => c.checked)) {
          breakpoint.parent.checkboxState = state;
        }
      }
    }

    const ids = this.allBreakpoints.filter(b => b.checked).map(b => b.id);
    for (const session of this._debugSessionTracker.getConcreteSessions()) {
      session.customRequest('setCustomBreakpoints', { ids });
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

  context.subscriptions.push(
    view.onDidChangeCheckboxState(async e => {
      provider.setEnabled(
        e.items.map(([i, state]) => [i, state === vscode.TreeItemCheckboxState.Checked]),
      );
    }),
  );

  context.subscriptions.push(view);

  context.subscriptions.push(
    vscode.commands.registerCommand(Commands.ToggleCustomBreakpoints, async () => {
      const items: (vscode.QuickPickItem & { id: string })[] = [...provider.allCategories].flatMap(
        category => [
          {
            kind: vscode.QuickPickItemKind.Separator,
            id: '',
            label: category.label,
          },
          ...category.children.map(bp => ({
            id: bp.id,
            label: `${bp.label}`,
            picked: bp.checked,
          })),
        ],
      );

      const picked = await vscode.window.showQuickPick(items, {
        canPickMany: true,
        placeHolder: 'Select breakpoints to enable',
      });

      if (!picked) {
        return;
      }

      const pickedSet = new Set(picked.map(i => i.id));
      provider.setEnabled(provider.allBreakpoints.map(i => [i, pickedSet.has(i.id)]));
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(Commands.RemoveAllCustomBreakpoints, () => {
      provider.setEnabled(provider.allBreakpoints.map(bp => [bp, false]));
    }),
  );
}
