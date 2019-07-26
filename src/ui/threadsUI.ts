/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as vscode from 'vscode';
import { DebugAdapter } from '../adapter/debugAdapter';
import { ExecutionContextTree, Thread } from '../adapter/threads';
import { AdapterFactory } from '../adapterFactory';

export function registerThreadsUI(context: vscode.ExtensionContext, factory: AdapterFactory) {
  const provider = new ThreadsDataProvider(context, factory);
  const treeView = vscode.window.createTreeView('pwa.threadsView', { treeDataProvider: provider });
  provider.setTreeView(treeView);

  context.subscriptions.push(vscode.commands.registerCommand('pwa.pauseThread', (item: ExecutionContextTree) => {
    item.thread.pause();
  }));
  context.subscriptions.push(vscode.commands.registerCommand('pwa.resumeThread', (item: ExecutionContextTree) => {
    item.thread.resume();
  }));
  context.subscriptions.push(vscode.commands.registerCommand('pwa.stopThread', (item: ExecutionContextTree) => {
    item.thread.stop();
  }));

  treeView.onDidChangeSelection(() => {
    const item = treeView.selection[0];
    const adapter = factory.activeAdapter();
    if (!adapter)
      return;
    adapter.selectExecutionContext(item);
  }, undefined, context.subscriptions);
}

class ThreadsDataProvider implements vscode.TreeDataProvider<ExecutionContextTree> {
  private _onDidChangeTreeData = new vscode.EventEmitter<undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private _contexts: ExecutionContextTree[] = [];
  private _disposables: vscode.Disposable[] = [];
  private _adapter: DebugAdapter;
  private _treeView: vscode.TreeView<ExecutionContextTree>;

  constructor(context: vscode.ExtensionContext, factory: AdapterFactory) {
    factory.onActiveAdapterChanged(adapter => this._setActiveAdapter(adapter), undefined, context.subscriptions);
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
    threadManager.onThreadPaused(thread => this._threadPaused(thread), undefined, this._disposables);
    threadManager.onThreadResumed(thread => this._threadResumed(thread), undefined, this._disposables);

    // Force populate the UI.
    threadManager.refreshExecutionContexts();

    // In case of lazy view initialization, pick already paused thread.
    for (const thread of threadManager.threads()) {
      if (thread.pausedDetails()) {
        this._threadPaused(thread);
        break;
      }
    }
  }

  _threadPaused(thread: Thread) {
    if (!this._adapter)
      return;
    const selection = this._treeView.selection[0];
    if (selection && selection.thread === thread) {
      // Selection is in the good thread, reuse it.
      this._adapter.selectExecutionContext(selection);
    } else {
      // Pick a new item in the UI.
      for (const context of this._contexts) {
        if (context.thread === thread) {
          this._treeView.reveal(context, { select: true });
          break;
        }
      }
    }
    this._onDidChangeTreeData.fire();
  }

  _threadResumed(_: Thread) {
    const selection = this._treeView.selection[0];
    if (selection)
      this._adapter.selectExecutionContext(selection);
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(item: ExecutionContextTree): vscode.TreeItem {
    const result = new vscode.TreeItem(item.name, vscode.TreeItemCollapsibleState.None);
    result.id = item.thread.threadId() + ':' + item.contextId;
    if (item.isThread) {
      if (item.thread.pausedDetails()) {
        result.description = 'PAUSED';
        result.contextValue = 'canRun';
      } else {
        result.description = 'RUNNING';
        result.contextValue = 'canPause';
      }
      if (item.thread.canStop())
        result.contextValue += ' canStop';
    } else {
      result.contextValue = 'pwa.executionContext';
    }
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
      keys.add(item.thread.threadId() + ':' + item.contextId);
      this._contexts.push({
        ...item,
        name: indentation + item.name
      });
      item.children.forEach(item => visit(indentation + tab, item));
    };
    contexts.forEach(item => visit('', item));
    this._onDidChangeTreeData.fire();

    const selected = this._treeView.selection[0];
    if (this._contexts[0] && (!selected || !keys.has(selected.thread.threadId() + ':' + selected.contextId)))
      this._treeView.reveal(this._contexts[0], { select: true });
  }
}
