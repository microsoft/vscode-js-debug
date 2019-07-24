// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as Net from 'net';
import * as queryString from 'querystring';
import * as vscode from 'vscode';
import DapConnection from './dap/connection';
import { Adapter, DisposableAdapterOwner } from './adapter/adapter';
import { ChromeAdapter } from './chrome/chromeAdapter';
import { NodeAdapter } from './node/nodeAdapter';
import { Source } from './adapter/sources';
import Dap from './dap/api';

export class AdapterFactory implements vscode.DebugAdapterDescriptorFactory {
  private _context: vscode.ExtensionContext;
  private _sessions = new Map<string, { session: vscode.DebugSession, server: Net.Server, owner: DisposableAdapterOwner }>();
  private _disposables: vscode.Disposable[];
  private _activeAdapter?: Adapter;

  private _onAdapterAddedEmitter = new vscode.EventEmitter<Adapter>();
  private _onAdapterRemovedEmitter = new vscode.EventEmitter<Adapter>();
  private _onActiveAdapterChangedEmitter = new vscode.EventEmitter<Adapter>();
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
          this._onAdapterAddedEmitter.fire(value.owner.adapter());
      }),
      vscode.debug.onDidTerminateDebugSession(session => {
        const value = this._sessions.get(session.id);
        this._sessions.delete(session.id);
        if (value) {
          value.owner.dispose();
          value.server.close();
          this._onAdapterRemovedEmitter.fire(value.owner.adapter());
        }
      }),
      vscode.debug.onDidChangeActiveDebugSession(session => {
        const value = session ? this._sessions.get(session.id) : undefined;
        if (value)
          this._activeAdapter = value.owner.adapter();
        else
          this._activeAdapter = undefined;
        this._onActiveAdapterChangedEmitter.fire(this._activeAdapter);
      }),
      this._onAdapterAddedEmitter,
      this._onAdapterRemovedEmitter,
      this._onActiveAdapterChangedEmitter
    ];
  }

  activeAdapter(): Adapter | undefined {
    return this._activeAdapter;
  }

  adapter(sessionId: string): Adapter | undefined {
    const value = this._sessions.get(sessionId);
    return value ? value.owner.adapter() : undefined;
  }

  adapters(): Adapter[] {
    return Array.from(this._sessions.values()).map(v => v.owner.adapter());
  }

  createDebugAdapterDescriptor(session: vscode.DebugSession, executable: vscode.DebugAdapterExecutable | undefined): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
    const server = Net.createServer(async socket => {
      const connection = new DapConnection(socket, socket);
      let rootPath = vscode.workspace.rootPath;
      if (session.workspaceFolder && session.workspaceFolder.uri.scheme === 'file:')
        rootPath = session.workspaceFolder.uri.path;
      const owner = session.configuration['runtimeExecutable'] ?
        await NodeAdapter.create(connection.dap(), rootPath) :
        await ChromeAdapter.create(connection.dap(), this._context.storagePath || this._context.extensionPath, rootPath);
      this._sessions.set(session.id, { session, server, owner });
    }).listen(0);
    return new vscode.DebugAdapterServer(server.address().port);
  }

  sourceForUri(factory: AdapterFactory, uri: vscode.Uri): { adapter: Adapter | undefined, source: Source | undefined } {
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
      value.owner.dispose();
      value.server.close();
      this._onAdapterRemovedEmitter.fire(value.owner.adapter());
    }
    for (const disposable of this._disposables)
      disposable.dispose();
    this._disposables = [];
  }
}
