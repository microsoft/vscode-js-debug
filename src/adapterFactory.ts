// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as Net from 'net';
import * as queryString from 'querystring';
import * as vscode from 'vscode';
import { DebugAdapter } from './adapter/debugAdapter';
import { Source } from './adapter/sources';
import { BrowserLauncher } from './browser/browserDelegate';
import Dap from './dap/api';
import DapConnection from './dap/connection';
import { NodeLauncher } from './node/nodeDelegate';
import { UberAdapter } from './uberAdapter';
import { UIDelegate } from './utils/uiDelegate';

export type Adapters = {adapter: DebugAdapter, uberAdapter: UberAdapter};

export class AdapterFactory implements vscode.DebugAdapterDescriptorFactory {
  private _context: vscode.ExtensionContext;
  private _uiDelegate: UIDelegate;
  private _sessions = new Map<string, { session: vscode.DebugSession, server: Net.Server, adapter: DebugAdapter, uberAdapter: UberAdapter }>();
  private _disposables: vscode.Disposable[];
  private _activeAdapters?: Adapters;

  private _onAdapterAddedEmitter = new vscode.EventEmitter<DebugAdapter>();
  private _onAdapterRemovedEmitter = new vscode.EventEmitter<DebugAdapter>();
  private _onActiveAdaptersChangedEmitter = new vscode.EventEmitter<Adapters>();
  readonly onAdapterAdded = this._onAdapterAddedEmitter.event;
  readonly onAdapterRemoved = this._onAdapterRemovedEmitter.event;
  readonly onActiveAdaptersChanged = this._onActiveAdaptersChangedEmitter.event;

  constructor(context: vscode.ExtensionContext, uiDelegate: UIDelegate) {
    this._context = context;
    this._uiDelegate = uiDelegate;
    context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory('pwa', this));
    context.subscriptions.push(this);

    this._disposables = [
      vscode.debug.onDidStartDebugSession(session => {
        const value = this._sessions.get(session.id);
        if (value)
          this._onAdapterAddedEmitter.fire(value.adapter);
      }),
      vscode.debug.onDidTerminateDebugSession(session => {
        const value = this._sessions.get(session.id);
        this._sessions.delete(session.id);
        if (value) {
          value.adapter.dispose();
          value.uberAdapter.dispose();
          value.server.close();
          this._onAdapterRemovedEmitter.fire(value.adapter);
        }
      }),
      vscode.debug.onDidChangeActiveDebugSession(session => {
        const value = session ? this._sessions.get(session.id) : undefined;
        if (value)
          this._activeAdapters = {adapter: value.adapter, uberAdapter: value.uberAdapter};
        else
          this._activeAdapters = undefined;
        this._onActiveAdaptersChangedEmitter.fire(this._activeAdapters);
      }),
      this._onAdapterAddedEmitter,
      this._onAdapterRemovedEmitter,
      this._onActiveAdaptersChangedEmitter
    ];
  }

  uiDelegate(): UIDelegate {
    return this._uiDelegate;
  }

  activeAdapters(): Adapters | undefined {
    return this._activeAdapters;
  }

  adapter(sessionId: string): DebugAdapter | undefined {
    const value = this._sessions.get(sessionId);
    return value ? value.adapter : undefined;
  }

  adapters(): DebugAdapter[] {
    return Array.from(this._sessions.values()).map(v => v.adapter);
  }

  createDebugAdapterDescriptor(session: vscode.DebugSession, executable: vscode.DebugAdapterExecutable | undefined): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
    const server = Net.createServer(async socket => {
      const connection = new DapConnection(socket, socket);
      let rootPath = vscode.workspace.rootPath;
      if (session.workspaceFolder && session.workspaceFolder.uri.scheme === 'file:')
        rootPath = session.workspaceFolder.uri.path;
      const uberAdapter = new UberAdapter(connection.dap(), this._uiDelegate);
      const adapter = uberAdapter.debugAdapter;
      this._sessions.set(session.id, { session, server, adapter, uberAdapter });
      uberAdapter.addLauncher(new NodeLauncher(adapter, rootPath));
      uberAdapter.addLauncher(new BrowserLauncher(adapter, this._uiDelegate, this._context.storagePath || this._context.extensionPath, rootPath));
    }).listen(0);
    return new vscode.DebugAdapterServer(server.address().port);
  }

  sourceForUri(factory: AdapterFactory, uri: vscode.Uri): { adapter: DebugAdapter | undefined, source: Source | undefined } {
    const query = queryString.parse(uri.query);
    const ref: Dap.Source = { path: uri.path, sourceReference: +(query['ref'] as string) };
    const sessionId = query['session'] as string;
    const adapter = factory.adapter(sessionId || '');
    if (!adapter)
      return { adapter: undefined, source: undefined };
    return { adapter, source: adapter.sourceContainer.source(ref) };
  }

  dispose() {
    for (const [session, value] of this._sessions) {
      this._sessions.delete(session);
      value.adapter.dispose();
      value.uberAdapter.dispose();
      value.server.close();
      this._onAdapterRemovedEmitter.fire(value.adapter);
    }
    for (const disposable of this._disposables)
      disposable.dispose();
    this._disposables = [];
  }
}
