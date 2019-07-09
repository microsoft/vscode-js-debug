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
      provider.executionContextsChanged(params.contexts);
    }
  });
}

class ExecutionContextDataProvider implements vscode.TreeDataProvider<ExecutionContext> {
  private _onDidChangeTreeData: vscode.EventEmitter<ExecutionContext | undefined> = new vscode.EventEmitter<ExecutionContext | undefined>();
  readonly onDidChangeTreeData: vscode.Event<ExecutionContext | undefined> = this._onDidChangeTreeData.event;
  private _contexts: ExecutionContext[] = [];

  constructor(context: vscode.ExtensionContext) {
  }

  getTreeItem(item: ExecutionContext): vscode.TreeItem {
    return new vscode.TreeItem(item.name, vscode.TreeItemCollapsibleState.None);
  }

  async getChildren(item?: ExecutionContext): Promise<ExecutionContext[]> {
    return item ? [] : this._contexts;
  }

  async getParent(item: Dap.ExecutionContext): Promise<Dap.ExecutionContext | undefined> {
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
