// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as vscode from 'vscode';

interface ExecutionContext {
  id: number;
  name: string;
  origin: string;
}

export function registerExecutionContextsUI(context: vscode.ExtensionContext) {
  const provider = new ExecutionContextDataProvider(context);
  vscode.window.createTreeView('executionContexts', { treeDataProvider: provider });
  const dispatchers: Map<string, (body: object) => void> = new Map();
  dispatchers.set('executionContextCreated', body => provider.executionContextCreated(body as ExecutionContext));
  dispatchers.set('executionContextDestroyed', body => provider.executionContextDestroyed(body as { id: number }));
  dispatchers.set('executionContextCleared', body => provider.executionContextCleared());
  vscode.debug.onDidReceiveDebugSessionCustomEvent(e => {
    const handler = dispatchers.get(e.event);
    if (handler)
      handler(e.body);
  });
}

class ExecutionContextDataProvider implements vscode.TreeDataProvider<ExecutionContext> {
  private _onDidChangeTreeData: vscode.EventEmitter<ExecutionContext | undefined> = new vscode.EventEmitter<ExecutionContext | undefined>();
  readonly onDidChangeTreeData: vscode.Event<ExecutionContext | undefined> = this._onDidChangeTreeData.event;
  private _contexts: Map<number, ExecutionContext> = new Map();

  constructor(context: vscode.ExtensionContext) {
  }

  getTreeItem(item: ExecutionContext): vscode.TreeItem {
    return new vscode.TreeItem(item.name || item.origin);
  }

  async getChildren(item?: ExecutionContext): Promise<ExecutionContext[]> {
    if (!item)
      return Array.from(this._contexts.values());
    return [];
  }

  async getParent(item: ExecutionContext): Promise<ExecutionContext | undefined> {
    return undefined;
  }

  executionContextCreated(ec: ExecutionContext): void {
    this._contexts.set(ec.id, ec);
    this._onDidChangeTreeData.fire(undefined);
  }

  executionContextDestroyed(params: {id: number}): void {
    this._contexts.delete(params.id);
    this._onDidChangeTreeData.fire(undefined);
  }

  executionContextCleared(): void {
    this._contexts.clear();
    this._onDidChangeTreeData.fire(undefined);
  }
}
