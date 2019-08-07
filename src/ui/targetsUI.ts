// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as path from 'path';
import * as vscode from 'vscode';
import { AdapterFactory } from '../adapterFactory';
import { Target } from '../targets/targets';
import { DebugAdapter } from '../adapter/debugAdapter';

export function registerTargetsUI(context: vscode.ExtensionContext, factory: AdapterFactory) {
  const provider = new TargetsDataProvider(context, factory);
  const treeView = vscode.window.createTreeView('pwa.targetsView', { treeDataProvider: provider });

  context.subscriptions.push(vscode.commands.registerCommand('pwa.pauseThread', (item: Target) => {
    const binder = factory.binderForTarget(item);
    const thread = binder && binder.thread(item);
    if (thread)
      thread.pause();
  }));
  context.subscriptions.push(vscode.commands.registerCommand('pwa.resumeThread', (item: Target) => {
    const binder = factory.binderForTarget(item);
    const thread = binder && binder.thread(item);
    if (thread)
      thread.resume();
  }));
  context.subscriptions.push(vscode.commands.registerCommand('pwa.stopTarget', (item: Target) => {
    item.stop!();
  }));
  context.subscriptions.push(vscode.commands.registerCommand('pwa.restartTarget', (item: Target) => {
    item.restart!();
  }));
  context.subscriptions.push(vscode.commands.registerCommand('pwa.attachToTarget', (item: Target) => {
    const binder = factory.binderForTarget(item);
    if (binder)
      binder.attach(item);
  }));
  context.subscriptions.push(vscode.commands.registerCommand('pwa.detachFromTarget', (item: Target) => {
    const binder = factory.binderForTarget(item);
    if (binder)
      binder.detach(item);
  }));
  context.subscriptions.push(vscode.commands.registerCommand('pwa.revealTargetScript', async (item: Target) => {
    const document = await vscode.workspace.openTextDocument(item.fileName()!);
    if (document)
      vscode.window.showTextDocument(document);
  }));

  // TODO: delete once threadId is available in evaluate / completions.
  treeView.onDidChangeSelection(async () => {
    const item = treeView.selection[0];
    const binder = item && factory.binderForTarget(item);
    if (!binder)
      return;
    const thread = binder.thread(item);
    const debugAdapter = binder.debugAdapter(item);
    if (thread && debugAdapter)
      debugAdapter.selectThread(thread);
  }, undefined, context.subscriptions);
}

const kDisposablesSymbol = Symbol('Disposables');

class TargetsDataProvider implements vscode.TreeDataProvider<Target> {
  private _onDidChangeTreeData = new vscode.EventEmitter<undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private _targets: Target[] = [];
  private _disposables: vscode.Disposable[] = [];
  private _extensionPath: string;
  private _throttlerTimer: NodeJS.Timer | undefined;
  private _factory: AdapterFactory;

  constructor(context: vscode.ExtensionContext, factory: AdapterFactory) {
    this._extensionPath = context.extensionPath;

    const onAdapter = (debugAdapter: DebugAdapter) => {
      debugAdapter[kDisposablesSymbol] = [
        debugAdapter.threadManager.onThreadAdded(() => this._scheduleThrottledTargetsUpdate()),
        debugAdapter.threadManager.onThreadRemoved(() => this._scheduleThrottledTargetsUpdate()),
        debugAdapter.threadManager.onThreadPaused(() => this._scheduleThrottledTargetsUpdate()),
        debugAdapter.threadManager.onThreadResumed(() => this._scheduleThrottledTargetsUpdate()),
      ];
    };
    factory.onAdapterAdded(onAdapter, undefined, this._disposables);
    factory.adapters().forEach(onAdapter);
    factory.onAdapterRemoved(debugAdapter => {
      for (const disposable of debugAdapter[kDisposablesSymbol] || [])
        disposable.dispose();
    });

    this._factory = factory;
    factory.onTargetListChanged(() => this._scheduleThrottledTargetsUpdate(), undefined, this._disposables);
    this._scheduleThrottledTargetsUpdate();
  }

  _scheduleThrottledTargetsUpdate() {
    if (this._throttlerTimer)
      clearTimeout(this._throttlerTimer);
    this._throttlerTimer = setTimeout(() => {
      this._targetsChanged();
    }, 100);
  }

  _iconPath(fileName: string): { dark: string, light: string } {
    return {
      dark: path.join(this._extensionPath, 'resources', 'dark', fileName),
      light: path.join(this._extensionPath, 'resources', 'light', fileName)
    };
  }

  getTreeItem(item: Target): vscode.TreeItem {
    const result = new vscode.TreeItem(
        item.name(), item.children().length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
    result.id = item.id();
    // Do not expand / collapse on selection trick.
    result.command = {
      title: '',
      command: ''
    };
    if (item.type() === 'page')
      result.iconPath = this._iconPath('page.svg');
    else if (item.type() === 'service_worker')
      result.iconPath = this._iconPath('service-worker.svg');
    else if (item.type() === 'worker')
      result.iconPath = this._iconPath('worker.svg');
    else if (item.type() === 'node')
      result.iconPath = this._iconPath('node.svg');

    const binder = this._factory.binderForTarget(item);
    const thread = binder && binder.thread(item);
    if (thread) {
      result.contextValue = ' ' + item.type();
      if (thread.pausedDetails()) {
        result.description = 'PAUSED';
        result.contextValue += 'canRun';
      } else {
        result.description = 'ATTACHED';
        result.contextValue += 'canPause';
      }
      if (item.canDetach())
        result.contextValue += ' canDetach';
    } else {
      if (item.canAttach())
        result.contextValue += ' canAttach';
    }
    if (item.canRestart())
      result.contextValue += ' canRestart';
    if (item.canStop())
      result.contextValue += ' canStop';
    if (item.fileName())
      result.contextValue += ' canReveal';
    return result;
  }

  async getChildren(item?: Target): Promise<Target[]> {
    return item ? item.children() : this._targets.filter(t => !t.parent());
  }

  async getParent(item: Target): Promise<Target | undefined> {
    return item.parent();
  }

  _targetsChanged(): void {
    this._targets = this._factory.targetList();
    this._onDidChangeTreeData.fire();
  }
}
