/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
import * as path from 'path';
import * as vscode from 'vscode';
import { DebugAdapter } from '../adapter/debugAdapter';
import { ExecutionContext, Thread } from '../adapter/threads';
import { AdapterFactory } from '../adapterFactory';

export function registerThreadsUI(context: vscode.ExtensionContext, factory: AdapterFactory) {
  const provider = new ThreadsDataProvider(context, factory);
  const treeView = vscode.window.createTreeView('pwa.threadsView', { treeDataProvider: provider });
  provider.setTreeView(treeView);

  context.subscriptions.push(vscode.commands.registerCommand('pwa.pauseThread', (item: ExecutionContext) => {
    item.thread.pause();
  }));
  context.subscriptions.push(vscode.commands.registerCommand('pwa.resumeThread', (item: ExecutionContext) => {
    item.thread.resume();
  }));
  context.subscriptions.push(vscode.commands.registerCommand('pwa.stopThread', (item: ExecutionContext) => {
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

class ThreadsDataProvider implements vscode.TreeDataProvider<ExecutionContext> {
  private _onDidChangeTreeData = new vscode.EventEmitter<undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private _contexts: ExecutionContext[] = [];
  private _disposables: vscode.Disposable[] = [];
  private _adapter: DebugAdapter;
  private _treeView: vscode.TreeView<ExecutionContext>;
  private _extensionPath: string;

  constructor(context: vscode.ExtensionContext, factory: AdapterFactory) {
    this._extensionPath = context.extensionPath;
    factory.onActiveAdapterChanged(adapter => this._setActiveAdapter(adapter), undefined, context.subscriptions);
  }

  setTreeView(treeView: vscode.TreeView<ExecutionContext>) {
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

  _iconPath(fileName: string): { dark: string, light: string } {
    return {
      dark: path.join(this._extensionPath, 'resources', 'dark', fileName),
      light: path.join(this._extensionPath, 'resources', 'light', fileName)
    };
  }

  getTreeItem(item: ExecutionContext): vscode.TreeItem {
    const result = new vscode.TreeItem(item.name);
    result.id = uniqueId(item);
    if (item.type === 'page')
      result.iconPath = this._iconPath('page.svg');
    else if (item.type === 'service_worker')
      result.iconPath = this._iconPath('service-worker.svg');

    if (item.isThread) {
      result.contextValue = ' ' + item.type;
      if (item.thread.pausedDetails()) {
        result.description = 'PAUSED';
        result.contextValue += 'canRun';
      } else {
        result.description = 'RUNNING';
        result.contextValue += 'canPause';
      }
      if (item.thread.canStop())
        result.contextValue += ' canStop';
    } else {
      result.contextValue = 'pwa.executionContext';
    }
    return result;
  }

  async getChildren(item?: ExecutionContext): Promise<ExecutionContext[]> {
    return item ? [] : this._contexts;
  }

  async getParent(item: ExecutionContext): Promise<ExecutionContext | undefined> {
    return undefined;
  }

  executionContextsChanged(contexts: ExecutionContext[]): void {
    this._contexts = [];
    const keys = new Set<string>();
    const tab = '\u00A0\u00A0\u00A0\u00A0';
    const visit = (depth: number, item: ExecutionContext) => {
      keys.add(uniqueId(item));
      let unicodeIcon = '';
      if (item.type === 'iframe')
        unicodeIcon = '\uD83D\uDCC4 ';
      else if (item.type === 'worker')
        unicodeIcon = '\uD83D\uDC77 ';
      const indentation = tab.repeat(Math.max(0, depth - 1));  // Do not indent the first level.
      this._contexts.push({
        ...item,
        name: indentation + unicodeIcon + item.name
      });
      item.children.forEach(item => visit(depth + 1, item));
    };
    contexts.forEach(item => visit(0, item));
    this._onDidChangeTreeData.fire();
  }
}

function uniqueId(item: ExecutionContext): string {
  return item.thread.threadId() + ':' + (item.description ? item.description.id : '');
}
