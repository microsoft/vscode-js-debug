/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as vscode from 'vscode';
import {CustomBreakpoint, customBreakpoints} from '../adapter/customBreakpoints';
import Dap from '../dap/api';
import {AdapterFactory} from '../adapterFactory';
import {Adapter} from '../adapter/adapter';

class Breakpoint {
  id: string;
  label: string;
  enabled: boolean;
  treeItem: vscode.TreeItem;

  constructor(cb: CustomBreakpoint, enabled: boolean) {
    this.id = cb.id;
    this.enabled = enabled;
    this.label = `${cb.group}: ${cb.title}`;
    this.treeItem = new vscode.TreeItem(this.label, vscode.TreeItemCollapsibleState.None);
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

    const sendState = (adapter: Adapter) => {
      const params: Dap.UpdateCustomBreakpointsParams = {
        breakpoints: this._collectState().map(id => ({id, enabled: true}))
      };
      adapter.onUpdateCustomBreakpoints(params);
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
    const payload: Dap.CustomBreakpoint[] = breakpoints.map(b => ({id: b.id, enabled: true}));
    this._changeBreakpoints(payload);
  }

  removeBreakpoints(breakpointIds: string[]) {
    const payload: Dap.CustomBreakpoint[] = [];
    for (const id of breakpointIds)
      payload.push({id, enabled: false});
    this._changeBreakpoints(payload);
  }

  _changeBreakpoints(payload: Dap.CustomBreakpoint[]) {
    const state = new Map<string, boolean>();
    for (const p of payload)
      state.set(p.id, p.enabled);
    for (const b of this.breakpoints) {
      if (state.has(b.id))
        b.enabled = state.get(b.id) as boolean;
    }

    const params: Dap.UpdateCustomBreakpointsParams = {breakpoints: payload};
    this._factory.adapters().forEach(adapter => adapter.onUpdateCustomBreakpoints(params));
    this._onDidChangeTreeData.fire(undefined);
  }

  _collectState(): string[] {
    return this.breakpoints.filter(b => b.enabled).map(b => b.id);
  }
}

export function registerCustomBreakpointsUI(factory: AdapterFactory) {
  const provider = new BreakpointsDataProvider(factory);

  vscode.window.createTreeView('cdpBreakpoints', { treeDataProvider: provider });
  factory.context.subscriptions.push(vscode.commands.registerCommand('cdp.addCustomBreakpoints', e => {
    const quickPick = vscode.window.createQuickPick();
    const items = provider.breakpoints.filter(b => !b.enabled);
    quickPick.items = items;
    quickPick.onDidAccept(e => {
      provider.addBreakpoints(quickPick.selectedItems as Breakpoint[]);
      quickPick.dispose();
    });
    quickPick.show();
  }));

  factory.context.subscriptions.push(vscode.commands.registerCommand('cdp.removeAllCustomBreakpoints', e => {
    provider.removeBreakpoints(provider.breakpoints.filter(b => b.enabled).map(b => b.id));
  }));

  factory.context.subscriptions.push(vscode.commands.registerCommand('cdp.removeCustomBreakpoint', (treeItem: vscode.TreeItem) => {
    provider.removeBreakpoints([treeItem.id as string]);
  }));
}
