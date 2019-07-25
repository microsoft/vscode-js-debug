// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as vscode from 'vscode';
import { AdapterFactory } from '../adapterFactory';
import { Adapter } from '../adapter/adapter';
import { ExecutionContextTree } from '../adapter/threads';

export function registerExecutionContextsUI(factory: AdapterFactory) {
  const provider = new ExecutionContextDataProvider(factory);

  const treeView = vscode.window.createTreeView('pwa.executionContexts', { treeDataProvider: provider });

  treeView.onDidChangeSelection(() => {
    const item = treeView.selection[0];
    const adapter = factory.activeAdapter();
    if (!adapter)
      return;
    adapter.selectExecutionContext(item);
  });
}

class ExecutionContextDataProvider implements vscode.TreeDataProvider<ExecutionContextTree> {
  private _onDidChangeTreeData = new vscode.EventEmitter<undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private _contexts: ExecutionContextTree[] = [];
  private _disposables: vscode.Disposable[] = [];

  constructor(factory: AdapterFactory) {
    factory.onActiveAdapterChanged(adapter => this._setActiveAdapter(adapter));
  }

  _setActiveAdapter(adapter: Adapter) {
    for (const disposable of this._disposables)
      disposable.dispose();
    this._disposables = [];
    adapter.threadManager.onExecutionContextsChanged(params => this.executionContextsChanged(params), undefined, this._disposables);
    adapter.threadManager.refreshExecutionContexts();
  }

  getTreeItem(item: ExecutionContextTree): vscode.TreeItem {
    const result = new vscode.TreeItem(item.name, vscode.TreeItemCollapsibleState.None);
    result.contextValue = item.contextId ? 'pwa.executionContext' : 'pwa.thread';
    return result;
  }

  async getChildren(item?: ExecutionContextTree): Promise<ExecutionContextTree[]> {
    return item ? [] : this._contexts;
  }

  async getParent(item: ExecutionContextTree): Promise<ExecutionContextTree | undefined> {
    return undefined;
  }

  executionContextsChanged(contexts: ExecutionContextTree[]): void {
    this._contexts = [];
    const tab = '\u00A0\u00A0\u00A0\u00A0';
    const visit = (indentation: string, item: ExecutionContextTree) => {
      this._contexts.push({
        ...item,
        name: indentation + item.name
      });
      item.children.forEach(item => visit(indentation + tab, item));
    };
    contexts.forEach(item => visit('', item));
    this._onDidChangeTreeData.fire(undefined);
  }
}
