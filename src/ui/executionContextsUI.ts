// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as vscode from 'vscode';

interface ExecutionContext {
  id: number;
  name: string;
}

export function registerExecutionContextsUI(context: vscode.ExtensionContext) {
  const provider = new ExecutionContextDataProvider(context);
  vscode.window.createTreeView('executionContexts', { treeDataProvider: provider });
  vscode.debug.onDidReceiveDebugSessionCustomEvent(e => {
    if (e.event === 'executionContextsChanged')
      provider.executionContextsChanged(e.body['contexts'] as ExecutionContext[]);
  });
}

class ExecutionContextDataProvider implements vscode.TreeDataProvider<ExecutionContext> {
  private _onDidChangeTreeData: vscode.EventEmitter<ExecutionContext | undefined> = new vscode.EventEmitter<ExecutionContext | undefined>();
  readonly onDidChangeTreeData: vscode.Event<ExecutionContext | undefined> = this._onDidChangeTreeData.event;
  private _contexts: ExecutionContext[] = [];

  constructor(context: vscode.ExtensionContext) {
  }

  getTreeItem(item: ExecutionContext): vscode.TreeItem {
    return new vscode.TreeItem(item.name);
  }

  async getChildren(item?: ExecutionContext): Promise<ExecutionContext[]> {
    if (!item)
      return this._contexts;
    return [];
  }

  async getParent(item: ExecutionContext): Promise<ExecutionContext | undefined> {
    return undefined;
  }

  executionContextsChanged(contexts: ExecutionContext[]): void {
    this._contexts = contexts;
    this._onDidChangeTreeData.fire(undefined);
  }
}
