// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as vscode from 'vscode';
import { DebugAdapter } from '../adapter/debugAdapter';
import { ExecutionContextTree } from '../adapter/threads';
import { AdapterFactory } from '../adapterFactory';

export function registerThreadsUI(factory: AdapterFactory) {
  const provider = new ThreadsDataProvider(factory);
  const treeView = vscode.window.createTreeView('pwa.executionContexts', { treeDataProvider: provider });
  provider.setTreeView(treeView);

  treeView.onDidChangeSelection(() => {
    const item = treeView.selection[0];
    const adapter = factory.activeAdapter();
    if (!adapter)
      return;
    adapter.selectExecutionContext(item);
  });
}

class ThreadsDataProvider implements vscode.TreeDataProvider<ExecutionContextTree> {
  private _onDidChangeTreeData = new vscode.EventEmitter<undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private _contexts: ExecutionContextTree[] = [];
  private _disposables: vscode.Disposable[] = [];
  private _adapter: DebugAdapter;
  private _treeView: vscode.TreeView<ExecutionContextTree>;

  constructor(factory: AdapterFactory) {
    factory.onActiveAdapterChanged(adapter => this._setActiveAdapter(adapter));
  }

  setTreeView(treeView: vscode.TreeView<ExecutionContextTree>) {
    this._treeView = treeView
  }

  _setActiveAdapter(adapter: DebugAdapter) {
    this._adapter = adapter;
    for (const disposable of this._disposables)
      disposable.dispose();
    this._disposables = [];

    if (!this._adapter) {
      this._contexts = [];
      this._onDidChangeTreeData.fire();
      return;
    }

    const threadManager = adapter.threadManager();
    threadManager.onExecutionContextsChanged(params => this.executionContextsChanged(params), undefined, this._disposables);
    threadManager.onThreadPaused(thread => this._threadPaused(thread.threadId()), undefined, this._disposables);
    threadManager.onThreadResumed(thread => this._threadResumed(thread.threadId()), undefined, this._disposables);

    // Force populate the UI.
    threadManager.refreshExecutionContexts();

    // In case of lazy view initialization, pick already paused thread.
    for (const thread of threadManager.threads()) {
      if (thread.pausedDetails()) {
        this._threadPaused(thread.threadId());
        break;
      }
    }
  }

  _threadPaused(threadId: number) {
    if (!this._adapter)
      return;
    const selection = this._treeView.selection[0];

    if (selection && selection.threadId === threadId) {
      // Selection is in the good thread, reuse it.
      this._adapter.selectExecutionContext(selection);
    } else {
      // Pick a new item in the UI.
      for (const context of this._contexts) {
        if (context.threadId === threadId) {
          this._treeView.reveal(context, { select: true });
          break;
        }
      }
    }
    this._onDidChangeTreeData.fire();
  }

  _threadResumed(threadId: number) {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(item: ExecutionContextTree): vscode.TreeItem {
    const result = new vscode.TreeItem(item.name, vscode.TreeItemCollapsibleState.None);
    result.id = item.threadId + ':' + item.contextId;
    const thread = this._adapter ? this._adapter.threadManager().thread(item.threadId) : undefined;
    if (thread && thread.pausedDetails())
      result.description = 'PAUSED';
    else if (thread)
      result.description = 'RUNNING';
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
    const keys = new Set<string>();
    const tab = '\u00A0\u00A0\u00A0\u00A0';
    const visit = (indentation: string, item: ExecutionContextTree) => {
      keys.add(item.threadId + ':' + item.contextId);
      this._contexts.push({
        ...item,
        name: indentation + item.name
      });
      item.children.forEach(item => visit(indentation + tab, item));
    };
    contexts.forEach(item => visit('', item));
    this._onDidChangeTreeData.fire(undefined);

    const selected = this._treeView.selection[0];
    if (!selected || !keys.has(selected.threadId + ':' + selected.contextId))
      this._treeView.reveal(this._contexts[0], { select: true });
  }
}
