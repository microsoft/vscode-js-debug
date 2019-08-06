// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as path from 'path';
import * as vscode from 'vscode';
import { Thread } from '../adapter/threads';
import { AdapterFactory, Adapters } from '../adapterFactory';
import { Target } from '../adapter/targets';

export function registerTargetsUI(context: vscode.ExtensionContext, factory: AdapterFactory) {
  const provider = new TargetsDataProvider(context, factory);
  const treeView = vscode.window.createTreeView('pwa.targetsView', { treeDataProvider: provider });

  context.subscriptions.push(vscode.commands.registerCommand('pwa.pauseThread', (item: Target) => {
    const thread = threadForTarget(factory, item);
    if (thread)
      thread.pause();
  }));
  context.subscriptions.push(vscode.commands.registerCommand('pwa.resumeThread', (item: Target) => {
    const thread = threadForTarget(factory, item);
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
    const adapters = factory.activeAdapters();
    if (adapters)
      adapters.uberAdapter.attach(item);
  }));
  context.subscriptions.push(vscode.commands.registerCommand('pwa.detachFromTarget', (item: Target) => {
    const adapters = factory.activeAdapters();
    if (adapters)
      adapters.uberAdapter.detach(item);
  }));
  context.subscriptions.push(vscode.commands.registerCommand('pwa.revealTargetScript', async (item: Target) => {
    const document = await vscode.workspace.openTextDocument(item.fileName()!);
    if (document)
      vscode.window.showTextDocument(document);
  }));

  treeView.onDidChangeSelection(async () => {
    const item = treeView.selection[0];
    const adapters = factory.activeAdapters();
    if (!adapters)
      return;
    adapters.adapter.selectThread(adapters.uberAdapter.thread(item));
  }, undefined, context.subscriptions);
}

class TargetsDataProvider implements vscode.TreeDataProvider<Target> {
  private _onDidChangeTreeData = new vscode.EventEmitter<undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private _targets: Target[] = [];
  private _disposables: vscode.Disposable[] = [];
  private _adapters: Adapters | undefined;
  private _extensionPath: string;
  private _throttlerTimer: NodeJS.Timer | undefined;

  constructor(context: vscode.ExtensionContext, factory: AdapterFactory) {
    this._extensionPath = context.extensionPath;
    factory.onActiveAdaptersChanged(adapters => this._setActiveAdapters(adapters), undefined, context.subscriptions);
  }

  _setActiveAdapters(adapters: Adapters) {
    this._adapters = adapters;
    for (const disposable of this._disposables)
      disposable.dispose();
    this._disposables = [];

    if (!this._adapters) {
      this._targets = [];
      if (this._throttlerTimer)
        clearTimeout(this._throttlerTimer);
      this._onDidChangeTreeData.fire();
      return;
    }

    adapters.adapter.threadManager.onThreadPaused(() => this._scheduleThrottledTargetsUpdate(), undefined, this._disposables);
    adapters.adapter.threadManager.onThreadResumed(() => this._scheduleThrottledTargetsUpdate(), undefined, this._disposables);

    this._scheduleThrottledTargetsUpdate();
    adapters.uberAdapter.onTargetListChanged(() => this._scheduleThrottledTargetsUpdate(), undefined, this._disposables);
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

    const thread = this._adapters ? this._adapters.uberAdapter.thread(item) : undefined;
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
    if (!this._adapters)
      return;
    this._targets = this._adapters.uberAdapter.targetList();
    this._onDidChangeTreeData.fire();
  }
}

function threadForTarget(factory: AdapterFactory, target: Target): Thread | undefined {
  const adapters = factory.activeAdapters();
  if (!adapters)
    return undefined;
  return adapters.uberAdapter.thread(target);
}
