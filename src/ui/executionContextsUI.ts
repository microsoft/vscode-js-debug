// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as vscode from 'vscode';
import Dap from '../dap/api';

type ExecutionContext = Dap.ExecutionContext & {
  threadId?: number;
}

export function registerExecutionContextsUI(context: vscode.ExtensionContext) {
  const provider = new ExecutionContextDataProvider(context);
  vscode.window.createTreeView('executionContexts', { treeDataProvider: provider });
  vscode.debug.onDidReceiveDebugSessionCustomEvent(e => {
    if (e.event === 'executionContextsChanged') {
      const params = e.body as Dap.ExecutionContextsChangedEventParams;
      provider.executionContextsChanged(params.threadId, params.contexts);
    }
  });
}

class ExecutionContextDataProvider implements vscode.TreeDataProvider<ExecutionContext> {
  private _onDidChangeTreeData: vscode.EventEmitter<ExecutionContext | undefined> = new vscode.EventEmitter<ExecutionContext | undefined>();
  readonly onDidChangeTreeData: vscode.Event<ExecutionContext | undefined> = this._onDidChangeTreeData.event;
  private _contexts: Map<number, ExecutionContext[]> = new Map();

  constructor(context: vscode.ExtensionContext) {
  }

  getTreeItem(item: ExecutionContext): vscode.TreeItem {
    return new vscode.TreeItem(item.name, item.threadId ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
  }

  async getChildren(item?: ExecutionContext): Promise<ExecutionContext[]> {
    if (item && !item.threadId)
      return [];
    if (item && item.threadId)
      return (this._contexts.get(item.threadId) || []).filter(c => !c.threadId);
    const result: ExecutionContext[] = [];
    for (const [, contexts] of this._contexts) {
      if (contexts.length)
        result.push(contexts[0]);
    }
    return result;
  }

  async getParent(item: Dap.ExecutionContext): Promise<Dap.ExecutionContext | undefined> {
    return undefined;
  }

  executionContextsChanged(threadId: number, contexts: ExecutionContext[]): void {
    this._contexts.set(threadId, contexts);
    if (contexts.length)
      contexts[0].threadId = threadId;
    this._onDidChangeTreeData.fire(undefined);
  }
}
