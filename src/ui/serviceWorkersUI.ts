// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as vscode from 'vscode';
import { AdapterFactory } from '../adapterFactory';
import { Adapter } from '../adapter/adapter';
import { ChromeAdapter } from '../chrome/chromeAdapter';
import { ServiceWorkerModel, ServiceWorkerVersion, ServiceWorkerRegistration, ServiceWorkerMode } from '../chrome/serviceWorkers';

type DataItem = ServiceWorkerVersion | ServiceWorkerRegistration | vscode.TreeItem;

interface QuickPickItem extends vscode.QuickPickItem {
  value: ServiceWorkerMode
}

export function registerServiceWorkersUI(context: vscode.ExtensionContext, factory: AdapterFactory) {
  const treeDataProvider = new ServiceWorkersDataProvider(factory);
  vscode.window.createTreeView('pwa.serviceWorkers', { treeDataProvider });
  context.subscriptions.push(vscode.commands.registerCommand('pwa.changeServiceWorkersMode', async e => {
    const quickPick = vscode.window.createQuickPick<QuickPickItem>();
    quickPick.items = [
      { value: 'default', label: 'default', description: 'Service Worker controls the page' },
      { value: 'bypass', label: 'bypass for network', description: 'Best for the live front-end & UI development' },
      { value: 'force', label: 'force update on load', description: 'Best for the Service Worker development & debugging' }
    ];
    quickPick.onDidAccept(e => {
      treeDataProvider.setMode(quickPick.selectedItems[0]);
      quickPick.dispose();
    });
    quickPick.show();
  }));
}

const childrenSymbol = Symbol('children');

class ServiceWorkersDataProvider implements vscode.TreeDataProvider<DataItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<DataItem | null | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private _disposables: vscode.Disposable[] = [];
  private _serviceWorkerModel: ServiceWorkerModel | undefined;
  private _modeItem: vscode.TreeItem;

  constructor(factory: AdapterFactory) {
    factory.onActiveAdapterChanged(adapter => this._setActiveAdapter(adapter));
    this._modeItem = new vscode.TreeItem('Mode: default', vscode.TreeItemCollapsibleState.None);
    this._modeItem.contextValue = 'pwa.serviceWorkerMode';
  }

  _setActiveAdapter(adapter: Adapter) {
    for (const disposable of this._disposables)
      disposable.dispose();
    this._disposables = [];
    this._serviceWorkerModel = undefined;
    const chromeAdapter = adapter[ChromeAdapter.symbol] as ChromeAdapter;
    if (!chromeAdapter)
      return;
    this._serviceWorkerModel = chromeAdapter.targetManager().serviceWorkerModel;
    this._disposables.push(this._serviceWorkerModel!.onDidChange(() => {
      this._onDidChangeTreeData.fire();
    }));
  }

  getTreeItem(item: DataItem): vscode.TreeItem {
    if (item instanceof ServiceWorkerRegistration)
      return new vscode.TreeItem(item.scopeURL, vscode.TreeItemCollapsibleState.Expanded);
    if (item instanceof ServiceWorkerVersion) {
      const scriptURL = item.scriptURL.substring(item.registration.scopeURL.length);
      const revision = item.revisions[0];
      return new vscode.TreeItem(`${item.runningStatus()}${scriptURL} #${item.id} (${revision.status})`, vscode.TreeItemCollapsibleState.None);
    }
    return item;
  }

  async getChildren(item?: DataItem): Promise<DataItem[]> {
    if (!item)
      return [this._modeItem, ...(this._serviceWorkerModel ? this._serviceWorkerModel.registrations() : [])];
    if (item instanceof ServiceWorkerVersion)
      return [];
    if (item instanceof ServiceWorkerRegistration)
      return Array.from(item.versions.values());
    return item[childrenSymbol] || [];
  }

  async getParent(item: DataItem): Promise<DataItem | undefined> {
    if (!this._serviceWorkerModel)
      return undefined;
    if (item instanceof ServiceWorkerRegistration)
      return undefined;
    if (item instanceof ServiceWorkerVersion)
      return undefined;
    return undefined;
  }

  setMode(item: QuickPickItem) {
    this._modeItem.label = `Mode: ${item.label}`;
    ServiceWorkerModel.setModeForAll(item.value);
    this._onDidChangeTreeData.fire(this._modeItem);
  }
}
