// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as Net from 'net';
import * as queryString from 'querystring';
import * as vscode from 'vscode';
import DapConnection from './dap/connection';
import { BrowserDelegate } from './browser/browserDelegate';
import { NodeDelegate } from './node/nodeDelegate';
import { Source } from './adapter/sources';
import Dap from './dap/api';
import { DebugAdapter } from './adapter/debugAdapter';

export class AdapterFactory implements vscode.DebugAdapterDescriptorFactory {
  private _context: vscode.ExtensionContext;
  private _sessions = new Map<string, { session: vscode.DebugSession, server: Net.Server, adapter: DebugAdapter }>();
  private _disposables: vscode.Disposable[];
  private _activeAdapter?: DebugAdapter;

  private _onAdapterAddedEmitter = new vscode.EventEmitter<DebugAdapter>();
  private _onAdapterRemovedEmitter = new vscode.EventEmitter<DebugAdapter>();
  private _onActiveAdapterChangedEmitter = new vscode.EventEmitter<DebugAdapter>();
  readonly onAdapterAdded = this._onAdapterAddedEmitter.event;
  readonly onAdapterRemoved = this._onAdapterRemovedEmitter.event;
  readonly onActiveAdapterChanged = this._onActiveAdapterChangedEmitter.event;

  constructor(context: vscode.ExtensionContext) {
    this._context = context;
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
          value.server.close();
          this._onAdapterRemovedEmitter.fire(value.adapter);
        }
      }),
      vscode.debug.onDidChangeActiveDebugSession(session => {
        const value = session ? this._sessions.get(session.id) : undefined;
        if (value)
          this._activeAdapter = value.adapter;
        else
          this._activeAdapter = undefined;
        this._onActiveAdapterChangedEmitter.fire(this._activeAdapter);
      }),
      this._onAdapterAddedEmitter,
      this._onAdapterRemovedEmitter,
      this._onActiveAdapterChangedEmitter
    ];
  }

  activeAdapter(): DebugAdapter | undefined {
    return this._activeAdapter;
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
      const adapter = new DebugAdapter(connection.dap());
      this._sessions.set(session.id, { session, server, adapter });
      if (session.configuration['command'])
        new NodeDelegate(adapter, rootPath);
      if (session.configuration['url'])
        new BrowserDelegate(adapter, this._context.storagePath || this._context.extensionPath, rootPath);
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
      value.server.close();
      this._onAdapterRemovedEmitter.fire(value.adapter);
    }
    for (const disposable of this._disposables)
      disposable.dispose();
    this._disposables = [];
  }
}
