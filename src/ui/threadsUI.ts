// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.
import * as path from 'path';
import * as vscode from 'vscode';
import { DebugAdapter } from '../adapter/debugAdapter';
import { Thread } from '../adapter/threads';
import { AdapterFactory } from '../adapterFactory';
import { Target } from '../adapter/targets';

export function registerThreadsUI(context: vscode.ExtensionContext, factory: AdapterFactory) {
  const provider = new ThreadsDataProvider(context, factory);
  const treeView = vscode.window.createTreeView('pwa.threadsView', { treeDataProvider: provider });
  provider.setTreeView(treeView);

  context.subscriptions.push(vscode.commands.registerCommand('pwa.pauseThread', (item: Target) => {
    item.thread!.pause();
  }));
  context.subscriptions.push(vscode.commands.registerCommand('pwa.resumeThread', (item: Target) => {
    item.thread!.resume();
  }));
  context.subscriptions.push(vscode.commands.registerCommand('pwa.stopTarget', (item: Target) => {
    item.stop!();
  }));
  context.subscriptions.push(vscode.commands.registerCommand('pwa.restartTarget', (item: Target) => {
    item.restart!();
  }));
  context.subscriptions.push(vscode.commands.registerCommand('pwa.attachToTarget', (item: Target) => {
    item.attach!();
  }));
  context.subscriptions.push(vscode.commands.registerCommand('pwa.detachFromTarget', (item: Target) => {
    item.detach!();
  }));

  treeView.onDidChangeSelection(() => {
    const item = treeView.selection[0];
    const adapter = factory.activeAdapter();
    if (!adapter)
      return;
    adapter.selectTarget(item);
  }, undefined, context.subscriptions);
}

class ThreadsDataProvider implements vscode.TreeDataProvider<Target> {
  private _onDidChangeTreeData = new vscode.EventEmitter<undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private _contexts: Target[] = [];
  private _disposables: vscode.Disposable[] = [];
  private _adapter: DebugAdapter;
  private _treeView: vscode.TreeView<Target>;
  private _extensionPath: string;

  constructor(context: vscode.ExtensionContext, factory: AdapterFactory) {
    this._extensionPath = context.extensionPath;
    factory.onActiveAdapterChanged(adapter => this._setActiveAdapter(adapter), undefined, context.subscriptions);
  }

  setTreeView(treeView: vscode.TreeView<Target>) {
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

    adapter.threadManager.onThreadPaused(thread => this._threadPaused(thread), undefined, this._disposables);
    adapter.threadManager.onThreadResumed(thread => this._threadResumed(thread), undefined, this._disposables);

    this._executionContextsChanged(adapter.targetForest());
    adapter.onTargetForestChanged(forest => this._executionContextsChanged(forest), undefined, this._disposables);

    // In case of lazy view initialization, pick already paused thread.
    for (const thread of adapter.threadManager.threads()) {
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
      this._adapter.selectTarget(selection);
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
      this._adapter.selectTarget(selection);
    this._onDidChangeTreeData.fire();
  }

  _iconPath(fileName: string): { dark: string, light: string } {
    return {
      dark: path.join(this._extensionPath, 'resources', 'dark', fileName),
      light: path.join(this._extensionPath, 'resources', 'light', fileName)
    };
  }

  getTreeItem(item: Target): vscode.TreeItem {
    const result = new vscode.TreeItem(item.name);
    result.id = item.id;
    if (!item.name.startsWith('\u00A0')) {
      if (item.type === 'page')
        result.iconPath = this._iconPath('page.svg');
      else if (item.type === 'service_worker')
        result.iconPath = this._iconPath('service-worker.svg');
      else if (item.type === 'node')
        result.iconPath = this._iconPath('node.svg');
    }

    if (item.thread) {
      result.contextValue = ' ' + item.type;
      if (item.thread.pausedDetails()) {
        result.description = 'PAUSED';
        result.contextValue += 'canRun';
      } else {
        result.description = 'ATTACHED';
        result.contextValue += 'canPause';
      }
      if (item.detach)
        result.contextValue += ' canDetach';
    } else {
      if (item.attach)
        result.contextValue += ' canAttach';
    }
    if (item.restart)
      result.contextValue += ' canRestart';
    if (item.stop)
      result.contextValue += ' canStop';
    return result;
  }

  async getChildren(item?: Target): Promise<Target[]> {
    return item ? [] : this._contexts;
  }

  async getParent(item: Target): Promise<Target | undefined> {
    return undefined;
  }

  _executionContextsChanged(contexts: Target[]): void {
    this._contexts = [];
    const keys = new Set<string>();
    const tab = '\u00A0\u00A0\u00A0\u00A0';
    const visit = (depth: number, item: Target) => {
      keys.add(item.id);
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
