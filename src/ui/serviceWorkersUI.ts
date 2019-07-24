/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as vscode from 'vscode';
import { AdapterFactory } from '../adapterFactory';
import { Adapter } from '../adapter/adapter';
import { ChromeAdapter } from '../chrome/chromeAdapter';
import { ServiceWorkerModel, ServiceWorkerVersion, ServiceWorkerRegistration } from '../chrome/serviceWorkers';

type DataItem = ServiceWorkerVersion | ServiceWorkerRegistration;

export function registerServiceWorkersUI(factory: AdapterFactory) {
  const treeDataProvider = new ServiceWorkersDataProvider(factory);
  vscode.window.createTreeView('pwa.serviceWorkers', { treeDataProvider });
}

class ServiceWorkersDataProvider implements vscode.TreeDataProvider<DataItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private _disposables: vscode.Disposable[] = [];
  private _serviceWorkerModel: ServiceWorkerModel | undefined;

  constructor(factory: AdapterFactory) {
    factory.onActiveAdapterChanged(adapter => this._setActiveAdapter(adapter));
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
    if (item instanceof ServiceWorkerRegistration) {
      return new vscode.TreeItem(item.scopeURL, vscode.TreeItemCollapsibleState.Expanded);
    }
    const version = item as ServiceWorkerVersion;
    const scriptURL = version.scriptURL.substring(version.registration.scopeURL.length);
    const revision = version.revisions[0];
    return new vscode.TreeItem(`${version.runningStatus()}${scriptURL} #${version.id} (${revision.status})`, vscode.TreeItemCollapsibleState.None);
  }

  async getChildren(item?: DataItem): Promise<DataItem[]> {
    if (!this._serviceWorkerModel)
      return [];
    if (!item)
      return this._serviceWorkerModel.registrations();
    if (item instanceof ServiceWorkerVersion)
      return [];
    return Array.from(item.versions.values());
  }

  async getParent(item: DataItem): Promise<DataItem | undefined> {
    if (!this._serviceWorkerModel)
      return undefined;
    if (item instanceof ServiceWorkerRegistration)
      return undefined;
    return item.registration;
  }
}
