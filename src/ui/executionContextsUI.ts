// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as vscode from 'vscode';
import { AdapterFactory } from '../adapterFactory';
import { Adapter } from '../adapter/adapter';
import { ExecutionContext } from '../adapter/threadManager';

export function registerExecutionContextsUI(factory: AdapterFactory) {
  const provider = new ExecutionContextDataProvider(factory);

  const treeView = vscode.window.createTreeView('executionContexts', { treeDataProvider: provider });
  treeView.onDidChangeSelection(() => {
    const item = treeView.selection[0];
    const adapter = factory.activeAdapter();
    if (!adapter)
      return;
    adapter.setCurrentExecutionContext(item);
  });
}

class ExecutionContextDataProvider implements vscode.TreeDataProvider<ExecutionContext> {
  private _onDidChangeTreeData: vscode.EventEmitter<ExecutionContext | undefined> = new vscode.EventEmitter<ExecutionContext | undefined>();
  readonly onDidChangeTreeData: vscode.Event<ExecutionContext | undefined> = this._onDidChangeTreeData.event;
  private _contexts: ExecutionContext[] = [];
  private _disposables: vscode.Disposable[] = [];

  constructor(factory: AdapterFactory) {
    factory.onActiveAdapterChanged(adapter => this._setActiveAdapter(adapter));
  }

  _setActiveAdapter(adapter: Adapter) {
    for (const disposable of this._disposables)
      disposable.dispose();
    this._disposables = [];
    adapter.threadManager.onExecutionContextsChanged(params => this.executionContextsChanged(params), undefined, this._disposables);
  }

  getTreeItem(item: ExecutionContext): vscode.TreeItem {
    return new vscode.TreeItem(item.name, vscode.TreeItemCollapsibleState.None);
  }

  async getChildren(item?: ExecutionContext): Promise<ExecutionContext[]> {
    return item ? [] : this._contexts;
  }

  async getParent(item: ExecutionContext): Promise<ExecutionContext | undefined> {
    return undefined;
  }

  executionContextsChanged(contexts: ExecutionContext[]): void {
    this._contexts = [];
    const tab = '\u00A0\u00A0\u00A0\u00A0';
    const visit = (indentation: string, item: ExecutionContext) => {
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
