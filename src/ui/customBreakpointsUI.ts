// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as vscode from 'vscode';
import { CustomBreakpoint, CustomBreakpointId, customBreakpoints } from '../adapter/customBreakpoints';
import { AdapterFactory } from '../adapterFactory';
import { DebugAdapter } from '../adapter/debugAdapter';

class Breakpoint {
  id: CustomBreakpointId;
  label: string;
  enabled: boolean;
  treeItem: vscode.TreeItem;

  constructor(cb: CustomBreakpoint, enabled: boolean) {
    this.id = cb.id;
    this.enabled = enabled;
    this.label = `${cb.group}: ${cb.title}`;
    this.treeItem = new vscode.TreeItem(this.label);
    this.treeItem.id = cb.id;
  }

  static compare(a: Breakpoint, b: Breakpoint) {
    return a.label.localeCompare(b.label);
  }
}

class BreakpointsDataProvider implements vscode.TreeDataProvider<Breakpoint> {
  private _onDidChangeTreeData = new vscode.EventEmitter<Breakpoint | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private _factory: AdapterFactory;
  breakpoints: Breakpoint[];

  constructor(factory: AdapterFactory) {
    this._factory = factory;
    this.breakpoints = [];
    for (const cb of customBreakpoints().values())
      this.breakpoints.push(new Breakpoint(cb, false));

    const sendState = (adapter: DebugAdapter) => {
      adapter.threadManager().enableCustomBreakpoints(this.breakpoints.filter(b => b.enabled).map(b => b.id));
    };
    factory.onAdapterAdded(sendState);
    factory.adapters().forEach(sendState);
  }

  getTreeItem(item: Breakpoint): vscode.TreeItem {
    return item.treeItem;
  }

  async getChildren(item?: Breakpoint): Promise<Breakpoint[]> {
    if (!item)
      return this.breakpoints.filter(b => b.enabled).sort(Breakpoint.compare);
    return [];
  }

  async getParent(item: Breakpoint): Promise<Breakpoint | undefined> {
    return undefined;
  }

  addBreakpoints(breakpoints: Breakpoint[]) {
    for (const breakpoint of breakpoints)
      breakpoint.enabled = true;
    const ids = breakpoints.map(b => b.id);
    this._factory.adapters().forEach(adapter => adapter.threadManager().enableCustomBreakpoints(ids));
    this._onDidChangeTreeData.fire(undefined);
  }

  removeBreakpoints(breakpointIds: CustomBreakpointId[]) {
    const ids = new Set(breakpointIds);
    for (const breakpoint of this.breakpoints) {
      if (ids.has(breakpoint.id))
        breakpoint.enabled = false;
    }
    this._factory.adapters().forEach(adapter => adapter.threadManager().disableCustomBreakpoints(breakpointIds));
    this._onDidChangeTreeData.fire(undefined);
  }
}

export function registerCustomBreakpointsUI(context: vscode.ExtensionContext, factory: AdapterFactory) {
  const provider = new BreakpointsDataProvider(factory);

  vscode.window.createTreeView('pwa.breakpoints', { treeDataProvider: provider });
  context.subscriptions.push(vscode.commands.registerCommand('pwa.addCustomBreakpoints', e => {
    const quickPick = vscode.window.createQuickPick();
    const items = provider.breakpoints.filter(b => !b.enabled);
    quickPick.items = items;
    quickPick.onDidAccept(e => {
      provider.addBreakpoints(quickPick.selectedItems as Breakpoint[]);
      quickPick.dispose();
    });
    quickPick.show();
  }));

  context.subscriptions.push(vscode.commands.registerCommand('pwa.removeAllCustomBreakpoints', e => {
    provider.removeBreakpoints(provider.breakpoints.filter(b => b.enabled).map(b => b.id));
  }));

  context.subscriptions.push(vscode.commands.registerCommand('pwa.removeCustomBreakpoint', (treeItem: vscode.TreeItem) => {
    provider.removeBreakpoints([treeItem.id as string]);
  }));
}
