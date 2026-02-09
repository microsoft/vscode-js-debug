/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { customBreakpoints, ICustomBreakpoint, IXHRBreakpoint } from '../adapter/customBreakpoints';
import { Commands, CustomViews } from '../common/contributionUtils';
import { EventEmitter } from '../common/events';
import Dap from '../dap/api';
import { DebugSessionTracker } from './debugSessionTracker';

const xhrBreakpointsCategory = () => l10n.t('XHR/Fetch URLs');
const focusEmulationStorageKey = 'jsDebug.focusEmulation.enabled';

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
  id: string;
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

class BreakpointsRoot extends vscode.TreeItem {
  public get checked() {
    return this.checkboxState === vscode.TreeItemCheckboxState.Checked;
  }

  constructor() {
    super(l10n.t('Browser Breakpoints'), vscode.TreeItemCollapsibleState.Collapsed);
    this.checkboxState = vscode.TreeItemCheckboxState.Unchecked;
    this.id = 'browserBreakpoints';
  }
}

class FocusEmulationOption extends vscode.TreeItem {
  constructor(enabled: boolean) {
    super(l10n.t('Emulate a focused page'), vscode.TreeItemCollapsibleState.None);
    this.checkboxState = enabled
      ? vscode.TreeItemCheckboxState.Checked
      : vscode.TreeItemCheckboxState.Unchecked;
    this.tooltip = l10n.t(
      'When enabled, the debugged page will behave as if it has focus',
    );
    this.id = 'focusEmulation';
  }
}

type BreakpointItem = BreakpointsRoot | Breakpoint | Category | XHRBreakpoint;
type BrowserOptionItem = BreakpointItem | FocusEmulationOption;

class BrowserOptionsDataProvider implements vscode.TreeDataProvider<BrowserOptionItem> {
  private _onDidChangeTreeData = new EventEmitter<BrowserOptionItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private _debugSessionTracker: DebugSessionTracker;

  private readonly _breakpointsRoot = new BreakpointsRoot();
  private readonly categories = new Map<string, Category>();
  xhrBreakpoints: XHRBreakpoint[] = [];

  private readonly _emulationSessions = new Set<string>();
  private _focusEmulationEnabled = false;

  /** Gets all breakpoint categories */
  public get allCategories() {
    return this.categories.values();
  }

  /** Gets all custom breakpoints */
  public get allBreakpoints() {
    return [...this.allCategories].flatMap(c => c.children);
  }

  constructor(debugSessionTracker: DebugSessionTracker, focusEmulationEnabled: boolean) {
    this._focusEmulationEnabled = focusEmulationEnabled;

    for (const breakpoint of [...customBreakpoints().values()]) {
      let category = this.categories.get(breakpoint.group);
      if (!category) {
        category = new Category(breakpoint.group);
        this.categories.set(breakpoint.group, category);
      }
      category.children.push(new Breakpoint(breakpoint, category));
    }

    const xhrCategory = new Category(xhrBreakpointsCategory());
    xhrCategory.contextValue = 'xhrCategory';
    xhrCategory.checkboxState = undefined;
    this.categories.set(xhrBreakpointsCategory(), xhrCategory);

    this.xhrBreakpoints = [];

    this._debugSessionTracker = debugSessionTracker;
    debugSessionTracker.onSessionAdded(session => {
      if (!DebugSessionTracker.isConcreteSession(session)) {
        return;
      }

      const toEnable = this.allBreakpoints.filter(b => b.checked).map(b => b.id);
      if (toEnable.length > 0) {
        session.customRequest('setCustomBreakpoints', {
          xhr: this.xhrBreakpoints.filter(b => b.checkboxState).map(b => b.id),
          ids: toEnable,
        });
      }

      this._checkEmulationSupport(session);
    });

    debugSessionTracker.onSessionEnded(session => {
      if (this._emulationSessions.delete(session.id)) {
        this._onDidChangeTreeData.fire(undefined);
      }
    });
  }

  /** @inheritdoc */
  getTreeItem(item: BrowserOptionItem): vscode.TreeItem {
    return item;
  }

  /** @inheritdoc */
  getChildren(item?: BrowserOptionItem): vscode.ProviderResult<BrowserOptionItem[]> {
    if (!item) {
      const items: BrowserOptionItem[] = [this._breakpointsRoot];
      if (this._emulationSessions.size > 0) {
        items.unshift(new FocusEmulationOption(this._focusEmulationEnabled));
      }
      return items;
    }

    if (item instanceof BreakpointsRoot) {
      return [...this.categories.values()].sort((a, b) => a.label.localeCompare(b.label));
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
  getParent(item: BrowserOptionItem): vscode.ProviderResult<BrowserOptionItem> {
    if (item instanceof Category) {
      return this._breakpointsRoot;
    } else if (item instanceof Breakpoint) {
      return this.categories.get(item.group);
    } else if (item instanceof XHRBreakpoint) {
      return this.categories.get(xhrBreakpointsCategory());
    }

    return undefined;
  }

  public setFocusEmulation(enabled: boolean): void {
    this._focusEmulationEnabled = enabled;
    this._onFocusEmulationChanged?.(enabled);
    this._applyFocusEmulationToAllSessions();
    this._onDidChangeTreeData.fire(undefined);
  }

  /** Updates the enablement state of the breakpoints/categories */
  public setBreakpointsEnabled(breakpoints: [BreakpointItem, boolean][]) {
    for (const [breakpoint, enabled] of breakpoints) {
      const state = enabled
        ? vscode.TreeItemCheckboxState.Checked
        : vscode.TreeItemCheckboxState.Unchecked;

      breakpoint.checkboxState = state;

      if (breakpoint instanceof BreakpointsRoot) {
        for (const category of this.categories.values()) {
          category.checkboxState = state;
          for (const child of category.children) {
            child.checkboxState = state;
          }
        }
        for (const xhr of this.xhrBreakpoints) {
          xhr.checkboxState = state;
        }
        this.syncXHRCategoryState();
      } else if (breakpoint instanceof Category) {
        for (const child of this.getChildren(breakpoint) as XHRBreakpoint[]) {
          if (child.checkboxState !== state) {
            child.checkboxState = state;
          }
        }
        this._syncBreakpointsRootState();
      } else if (breakpoint instanceof Breakpoint || breakpoint instanceof XHRBreakpoint) {
        const parent = this.getParent(breakpoint) as Category;
        if (!enabled && parent.checked) {
          parent.checkboxState = state;
        } else if (
          enabled
          && (this.getChildren(parent) as XHRBreakpoint[]).every(
            c => c.checked || c.checkboxState == undefined,
          )
        ) {
          parent.checkboxState = state;
        }
        this._syncBreakpointsRootState();
      }
    }

    this.updateDebuggersState();
    this._onDidChangeTreeData.fire(undefined);
  }

  private updateDebuggersState() {
    const ids = this.allBreakpoints.filter(b => b.checked).map(b => b.id);
    const xhr = this.xhrBreakpoints.filter(b => b.checked).map(b => b.id);
    for (const session of this._debugSessionTracker.getConcreteSessions()) {
      session.customRequest('setCustomBreakpoints', { xhr, ids });
    }
  }

  addXHRBreakpoints(breakpoint: XHRBreakpoint) {
    if (this.xhrBreakpoints.some(b => b.id === breakpoint.id)) {
      return;
    }

    this.xhrBreakpoints.push(breakpoint);
    this.updateDebuggersState();
    this.syncXHRCategoryState();
    this._onDidChangeTreeData.fire(undefined);
  }

  removeXHRBreakpoint(breakpoint: XHRBreakpoint) {
    this.xhrBreakpoints = this.xhrBreakpoints.filter(b => b !== breakpoint);
    this.updateDebuggersState();
    this.syncXHRCategoryState();
    this._onDidChangeTreeData.fire(undefined);
  }

  syncXHRCategoryState() {
    const category = this.categories.get(xhrBreakpointsCategory());
    if (!category) {
      return;
    }

    if (!this.xhrBreakpoints.length) {
      category.checkboxState = undefined;
      return;
    }

    category.checkboxState = this.xhrBreakpoints.every(
        b => b.checkboxState === vscode.TreeItemCheckboxState.Checked,
      )
      ? vscode.TreeItemCheckboxState.Checked
      : vscode.TreeItemCheckboxState.Unchecked;
  }

  private _syncBreakpointsRootState(): void {
    const allChecked = [...this.categories.values()].every(c => c.checked);
    this._breakpointsRoot.checkboxState = allChecked
      ? vscode.TreeItemCheckboxState.Checked
      : vscode.TreeItemCheckboxState.Unchecked;
  }

  _onFocusEmulationChanged?: (enabled: boolean) => void;

  private async _checkEmulationSupport(session: vscode.DebugSession): Promise<void> {
    try {
      const result: Dap.CanEmulateResult = await session.customRequest('canEmulate', {});
      if (result.supported) {
        this._emulationSessions.add(session.id);
        this._onDidChangeTreeData.fire(undefined);

        if (this._focusEmulationEnabled) {
          session.customRequest('setFocusEmulation', { enabled: true });
        }
      }
    } catch {
      // Session doesn't support emulation
    }
  }

  private _applyFocusEmulationToAllSessions(): void {
    for (const sessionId of this._emulationSessions) {
      const session = this._debugSessionTracker.getById(sessionId);
      if (session) {
        session.customRequest('setFocusEmulation', { enabled: this._focusEmulationEnabled });
      }
    }
  }
}

export function registerCustomBreakpointsUI(
  context: vscode.ExtensionContext,
  debugSessionTracker: DebugSessionTracker,
) {
  const focusEmulationEnabled = context.workspaceState.get(focusEmulationStorageKey, false);
  const provider = new BrowserOptionsDataProvider(debugSessionTracker, focusEmulationEnabled);
  provider._onFocusEmulationChanged = enabled =>
    context.workspaceState.update(focusEmulationStorageKey, enabled);

  const view = vscode.window.createTreeView(CustomViews.EventListenerBreakpoints, {
    treeDataProvider: provider,
    showCollapseAll: true,
    manageCheckboxStateManually: true,
  });

  context.subscriptions.push(
    view.onDidChangeCheckboxState(async e => {
      const breakpointChanges: [BreakpointItem, boolean][] = [];
      for (const [item, state] of e.items) {
        const enabled = state === vscode.TreeItemCheckboxState.Checked;
        if (item instanceof FocusEmulationOption) {
          provider.setFocusEmulation(enabled);
        } else {
          breakpointChanges.push([item as BreakpointItem, enabled]);
        }
      }
      if (breakpointChanges.length) {
        provider.setBreakpointsEnabled(breakpointChanges);
      }
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
      provider.setBreakpointsEnabled(provider.allBreakpoints.map(i => [i, pickedSet.has(i.id)]));
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(Commands.RemoveAllCustomBreakpoints, () => {
      provider.setBreakpointsEnabled(
        [...provider.allBreakpoints, ...provider.xhrBreakpoints].map(bp => [bp, false]),
      );
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(Commands.AddXHRBreakpoints, () => {
      const inputBox = vscode.window.createInputBox();
      inputBox.title = l10n.t('Add XHR Breakpoint');
      inputBox.placeholder = l10n.t('Break when URL Contains');
      inputBox.onDidAccept(() => {
        const match = inputBox.value;
        provider.addXHRBreakpoints(new XHRBreakpoint({ match }, true));
        inputBox.dispose();
      });
      inputBox.show();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(Commands.EditXHRBreakpoint, (treeItem: vscode.TreeItem) => {
      const inputBox = vscode.window.createInputBox();
      inputBox.title = l10n.t('Edit XHR Breakpoint');
      inputBox.placeholder = l10n.t('Enter a URL or a pattern to match');
      inputBox.value = (treeItem as XHRBreakpoint).match;
      inputBox.onDidAccept(() => {
        const match = inputBox.value;
        provider.removeXHRBreakpoint(treeItem as XHRBreakpoint);
        provider.addXHRBreakpoints(
          new XHRBreakpoint(
            { match },
            treeItem.checkboxState == vscode.TreeItemCheckboxState.Checked,
          ),
        );
        inputBox.dispose();
      });
      inputBox.show();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(Commands.RemoveXHRBreakpoints, (treeItem: vscode.TreeItem) => {
      provider.removeXHRBreakpoint(treeItem as XHRBreakpoint);
    }),
  );
}
