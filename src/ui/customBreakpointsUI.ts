/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as vscode from 'vscode';
import { l10n } from 'vscode';
import {
  CustomBreakpointId,
  customBreakpoints,
  ICustomBreakpoint,
  IXHRBreakpoint,
} from '../adapter/customBreakpoints';
import { Commands, CustomViews } from '../common/contributionUtils';
import { EventEmitter } from '../common/events';
import { DebugSessionTracker } from './debugSessionTracker';

const XHRBreakpointsCategory = l10n.t('xhr.breakpoint.category', `XHR/Fetch URLs`);

class XHRBreakpoint extends vscode.TreeItem {
  public get checked() {
    return this.checkboxState === vscode.TreeItemCheckboxState.Checked;
  }

  match: string;
  constructor(xhr: IXHRBreakpoint, enabled: boolean) {
    super(
      xhr.match ? l10n.t('URL contains "{0}"', xhr.match) : l10n.t('Any XHR or fetch'),
      vscode.TreeItemCollapsibleState.None,
    );
    this.contextValue = 'xhrBreakpoint';
    this.id = xhr.match;
    this.match = xhr.match;
    this.checkboxState = enabled
      ? vscode.TreeItemCheckboxState.Checked
      : vscode.TreeItemCheckboxState.Unchecked;
  }

  static compare(a: XHRBreakpoint, b: XHRBreakpoint) {
    return a.match.localeCompare(b.match);
  }
}

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

class BreakpointsDataProvider
  implements vscode.TreeDataProvider<Breakpoint | Category | XHRBreakpoint>
{
  private _onDidChangeTreeData = new EventEmitter<Breakpoint | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private _debugSessionTracker: DebugSessionTracker;

  private readonly categories = new Map<string, Category>();
  xhrBreakpoints: XHRBreakpoint[];

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

    // add the XHR/Fetch URLs
    const xhrCategory = new Category(XHRBreakpointsCategory);
    xhrCategory.contextValue = 'xhrCategory';
    // xhrCategory.collapsibleState = undefined;
    xhrCategory.checkboxState = undefined;
    this.categories.set(XHRBreakpointsCategory, xhrCategory);

    this.xhrBreakpoints = [];

    this._debugSessionTracker = debugSessionTracker;
    debugSessionTracker.onSessionAdded(session => {
      if (!DebugSessionTracker.isConcreteSession(session)) {
        return;
      }

      const toEnable = this.allBreakpoints.filter(b => b.checked).map(b => b.id);
      if (toEnable.length === 0) {
        return;
      }

      session.customRequest('setCustomBreakpoints', {
        xhr: this.xhrBreakpoints.filter(b => b.checkboxState).map(b => b.id),
        ids: toEnable,
      });
    });
  }

  /** @inheritdoc */
  getTreeItem(item: Breakpoint | Category | XHRBreakpoint): vscode.TreeItem {
    return item;
  }

  /** @inheritdoc */
  getChildren(
    item?: Breakpoint | Category | XHRBreakpoint,
  ): vscode.ProviderResult<(Breakpoint | Category | XHRBreakpoint)[]> {
    if (!item) {
      return [...this.categories.values()];
    }

    if (item instanceof Category) {
      if (item.contextValue === 'xhrCategory') {
        const title = l10n.t('Add new URL...');
        const addNew = new vscode.TreeItem(title) as XHRBreakpoint;
        addNew.command = { title, command: Commands.AddXHRBreakpoints };
        return [...this.xhrBreakpoints, addNew];
      }
      return this.categories.get(item.label)?.children;
    }

    return [];
  }

  /** @inheritdoc */
  getParent(
    item: Breakpoint | Category | XHRBreakpoint,
  ): vscode.ProviderResult<Breakpoint | Category | XHRBreakpoint> {
    if (item instanceof Breakpoint) {
      return this.categories.get(item.group);
    } else if (item instanceof XHRBreakpoint) {
      return this.categories.get(XHRBreakpointsCategory);
    }

    return undefined;
  }

  /** Updates the enablement state of the breakpoints/categories */
  public setEnabled(breakpoints: [Breakpoint | Category | XHRBreakpoint, boolean][]) {
    for (const [breakpoint, enabled] of breakpoints) {
      const state = enabled
        ? vscode.TreeItemCheckboxState.Checked
        : vscode.TreeItemCheckboxState.Unchecked;

      breakpoint.checkboxState = state;

      if (breakpoint instanceof Category) {
        for (const child of this.getChildren(breakpoint) as XHRBreakpoint[]) {
          if (child.checkboxState !== state) {
            child.checkboxState = state;
          }
        }
      } else if (breakpoint instanceof Breakpoint || breakpoint instanceof XHRBreakpoint) {
        const parent = this.getParent(breakpoint) as Category;
        if (!enabled && parent.checked) {
          parent.checkboxState = state;
        } else if (
          enabled &&
          (this.getChildren(parent) as XHRBreakpoint[]).every(
            c => c.checked || c.checkboxState == undefined,
          )
        ) {
          parent.checkboxState = state;
        }
      }
    }

    const ids = this.allBreakpoints.filter(b => b.checked).map(b => b.id);
    const xhr = this.xhrBreakpoints.filter(b => b.checkboxState).map(b => b.id);
    for (const session of this._debugSessionTracker.getConcreteSessions()) {
      session.customRequest('setCustomBreakpoints', { xhr, ids });
      // session.customRequest('enableXHRBreakpoints', { ids: xhr });
      // session.customRequest('disableXHRBreakpoints', { ids: xhrDisabled });
    }

    this._onDidChangeTreeData.fire(undefined);
  }

  addXHRBreakpoints(breakpoints: XHRBreakpoint[]) {
    // filter out duplicates
    breakpoints = breakpoints.filter(b => !this.xhrBreakpoints.map(e => e.id).includes(b.id));
    const match = breakpoints.map(b => b.match);
    for (const breakpoint of breakpoints) this.xhrBreakpoints.push(breakpoint);
    for (const session of this._debugSessionTracker.getConcreteSessions())
      session.customRequest('setCustomBreakpoints', { xhr: match });
    const category = this.categories.get(XHRBreakpointsCategory);
    if (category) {
      category.checkboxState =
        this.xhrBreakpoints.length &&
        this.xhrBreakpoints.every(b => b.checkboxState === vscode.TreeItemCheckboxState.Checked)
          ? vscode.TreeItemCheckboxState.Checked
          : vscode.TreeItemCheckboxState.Unchecked;
    }
    this._onDidChangeTreeData.fire(undefined);
  }

  removeXHRBreakpoints(breakpoints: XHRBreakpoint[]) {
    const breakpointIds = breakpoints.map(b => b.id);
    this.xhrBreakpoints = this.xhrBreakpoints.filter(b => !breakpointIds.includes(b.id));
    for (const session of this._debugSessionTracker.getConcreteSessions())
      session.customRequest('disableXHRBreakpoints', { ids: breakpointIds });

    // if all XHR breakpoints are removed, disable the category
    if (this.xhrBreakpoints.length == 0) {
      const category = this.categories.get(XHRBreakpointsCategory);
      if (category) {
        category.checkboxState = undefined;
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

  context.subscriptions.push(
    vscode.commands.registerCommand(Commands.AddXHRBreakpoints, () => {
      const inputBox = vscode.window.createInputBox();
      inputBox.title = 'Add XHR Breakpoint';
      inputBox.placeholder = 'Break when URL Contains';
      inputBox.onDidAccept(() => {
        const match = inputBox.value;
        provider.addXHRBreakpoints([new XHRBreakpoint({ match }, true)]);
        inputBox.dispose();
      });
      inputBox.show();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(Commands.EditXHRBreakpoint, (treeItem: vscode.TreeItem) => {
      const inputBox = vscode.window.createInputBox();
      inputBox.title = 'Edit XHR Breakpoint';
      inputBox.placeholder = 'Enter a URL or a pattern to match';
      inputBox.value = (treeItem as XHRBreakpoint).match;
      inputBox.onDidAccept(() => {
        const match = inputBox.value;
        provider.removeXHRBreakpoints([treeItem as XHRBreakpoint]);
        provider.addXHRBreakpoints([
          new XHRBreakpoint(
            { match },
            treeItem.checkboxState == vscode.TreeItemCheckboxState.Checked,
          ),
        ]);
        inputBox.dispose();
      });
      inputBox.show();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(Commands.RemoveAllXHRBreakpoints, () => {
      provider.removeXHRBreakpoints(provider.xhrBreakpoints);
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(Commands.RemoveXHRBreakpoints, (treeItem: vscode.TreeItem) => {
      provider.removeXHRBreakpoints([treeItem as XHRBreakpoint]);
    }),
  );
}
