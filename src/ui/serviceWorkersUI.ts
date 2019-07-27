// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as path from 'path';
import * as vscode from 'vscode';
import { DebugAdapter } from '../adapter/debugAdapter';
import { AdapterFactory } from '../adapterFactory';
import { ChromeAdapter } from '../chrome/chromeAdapter';
import { ServiceWorkerMode, ServiceWorkerModel, ServiceWorkerVersion } from '../chrome/serviceWorkers';

type DataItem = ServiceWorkerVersion | vscode.TreeItem;

interface QuickPickItem extends vscode.QuickPickItem {
  value: ServiceWorkerMode
}

export function registerServiceWorkersUI(context: vscode.ExtensionContext, factory: AdapterFactory) {
  const treeDataProvider = new ServiceWorkersDataProvider(context, factory);
  vscode.window.createTreeView('pwa.serviceWorkers', { treeDataProvider });

  context.subscriptions.push(vscode.commands.registerCommand('pwa.changeServiceWorkersMode', async e => {
    const quickPick = vscode.window.createQuickPick<QuickPickItem>();
    quickPick.items = [
      { value: 'normal', label: 'NORMAL', description: 'Service Worker controls the page' },
      { value: 'bypass', label: 'BYPASS', description: 'Bypass SW for network. Best for the live front-end & UI development' },
      { value: 'force', label: 'FORCE UPDATE', description: 'Update SW on reload. Best for the Service Worker development & debugging' }
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
  private _extensionPath: string;

  constructor(context: vscode.ExtensionContext, factory: AdapterFactory) {
    this._extensionPath = context.extensionPath;
    this._modeItem = new vscode.TreeItem('Mode: NORMAL');
    this._modeItem.contextValue = 'pwa.serviceWorkerMode';
    factory.onActiveAdapterChanged(adapter => this._setActiveAdapter(adapter));
  }

  _setActiveAdapter(adapter: DebugAdapter) {
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

  _iconPath(fileName: string): { dark: string, light: string } {
    return {
      dark: path.join(this._extensionPath, 'resources', 'dark', fileName),
      light: path.join(this._extensionPath, 'resources', 'light', fileName)
    };
  }

  getTreeItem(item: DataItem): vscode.TreeItem {
    if (item instanceof ServiceWorkerVersion) {
      const result = new vscode.TreeItem(item.label(), vscode.TreeItemCollapsibleState.Expanded);
      result.iconPath = this._iconPath('service-worker.svg');
      result.id = item.registration.id + ':' + item.id;
      return result;
    }
    return item;
  }

  async getChildren(item?: DataItem): Promise<DataItem[]> {
    if (!item) {
      const result: DataItem[] = [this._modeItem];
      if (!this._serviceWorkerModel)
        return result;
      this._serviceWorkerModel.registrations().forEach(registration => {
        result.push(...Array.from(registration.versions.values()));
      });
      return result;
    }

    if (item instanceof ServiceWorkerVersion) {
      const createItem = (name: string, value: string, tooltip: string) => {
        const item =  new vscode.TreeItem(name);
        item.description = value.toLocaleUpperCase();
        item.tooltip = `${tooltip}: ${value}`;
        return item;
      };
      return [
        createItem('url', item.scriptURL.substring(item.registration.scopeURL.length), 'Service worker script URL'),
        createItem('scope', item.registration.scopeURL, 'Service worker scope'),
        createItem('status', item.status(), 'Service worker status'),
        createItem('script', item.runningStatus(), 'Service worker script status'),
        createItem('version', item.id, 'Service worker version')];
    }

    return item[childrenSymbol] || [];
  }

  async getParent(item: DataItem): Promise<DataItem | undefined> {
    return undefined;
  }

  setMode(item: QuickPickItem) {
    this._modeItem.label = `Mode: ${item.label}`;
    ServiceWorkerModel.setModeForAll(item.value);
    this._onDidChangeTreeData.fire(this._modeItem);
  }
}
