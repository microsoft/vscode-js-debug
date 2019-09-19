// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as net from 'net';
import * as queryString from 'querystring';
import * as vscode from 'vscode';
import { DebugAdapter } from './adapter/debugAdapter';
import { Source } from './adapter/sources';
import { Binder, BinderDelegate } from './binder';
import Dap from './dap/api';
import DapConnection from './dap/connection';
import { SessionManager } from './sessionManager';
import { BrowserLauncher } from './targets/browser/browserLauncher';
import { NodeLauncher } from './targets/node/nodeLauncher';
import { BrowserAttacher } from './targets/browser/browserAttacher';
import { Target } from './targets/targets';
import { Disposable, EventEmitter } from './utils/eventUtils';
import { checkVersion } from './version';

export class Session implements Disposable {
  private _server: net.Server;
  private _debugAdapter?: DebugAdapter;
  private _binder?: Binder;
  private _onTargetNameChanged?: Disposable;

  constructor(context: vscode.ExtensionContext, debugSession: vscode.DebugSession, target: Target | undefined, binderDelegate: BinderDelegate | undefined, callback: (debugAdapter: DebugAdapter) => void) {
    if (target && checkVersion('1.39.0'))
      this._onTargetNameChanged = target.onNameChanged(() => debugSession.name = target.name());

    this._server = net.createServer(async socket => {
      let rootPath = vscode.workspace.rootPath;
      if (debugSession.workspaceFolder && debugSession.workspaceFolder.uri.scheme === 'file:')
        rootPath = debugSession.workspaceFolder.uri.path;

      const connection = new DapConnection(socket, socket);
      this._debugAdapter = new DebugAdapter(connection.dap(), rootPath, {
        copyToClipboard: text => vscode.env.clipboard.writeText(text)
      });

      if (binderDelegate) {
        const launchers = [
          new NodeLauncher(this._debugAdapter.sourceContainer.rootPath),
          new BrowserLauncher(context.storagePath || context.extensionPath, this._debugAdapter.sourceContainer.rootPath),
          new BrowserAttacher(this._debugAdapter.sourceContainer.rootPath),
        ];
        this._binder = new Binder(binderDelegate, this._debugAdapter, launchers, debugSession.id);
      }

      callback(this._debugAdapter);
    }).listen(0);
  }

  descriptor(): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
    return new vscode.DebugAdapterServer(this._server.address().port);
  }

  debugAdapter(): DebugAdapter | undefined {
    return this._debugAdapter;
  }

  dispose() {
    if (this._binder)
      this._binder.dispose();
    if (this._debugAdapter)
      this._debugAdapter.dispose();
    if (this._onTargetNameChanged)
      this._onTargetNameChanged.dispose();
    this._server.close();
  }
}

export class AdapterFactory implements vscode.DebugAdapterDescriptorFactory, Disposable {
  private _context: vscode.ExtensionContext;
  private _disposables: Disposable[];
  private _onAdapterAddedEmitter = new EventEmitter<DebugAdapter>();
  private _onAdapterRemovedEmitter = new EventEmitter<DebugAdapter>();
  private _sessions = new Map<string, Session>();
  private _sessionManager: SessionManager;

  readonly onAdapterAdded = this._onAdapterAddedEmitter.event;
  readonly onAdapterRemoved = this._onAdapterRemovedEmitter.event;

  constructor(context: vscode.ExtensionContext) {
    this._context = context;
    context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory('pwa', this));
    context.subscriptions.push(this);
    this._disposables = [this._onAdapterAddedEmitter, this._onAdapterRemovedEmitter];
    this._sessionManager = new SessionManager();

    vscode.debug.onDidTerminateDebugSession(debugSession => {
      const session = this._sessions.get(debugSession.id);
      if (!session)
        return;
      this._sessions.delete(debugSession.id);
      if (session.debugAdapter())
        this._onAdapterRemovedEmitter.fire(session.debugAdapter()!);
      session.dispose();
    }, undefined, this._disposables);
  }

  adapters(): DebugAdapter[] {
    const result: DebugAdapter[] = [];
    for (const session of this._sessions.values()) {
      const adapter = session.debugAdapter();
      if (adapter)
        result.push(adapter);
    }
    return result;
  }

  createDebugAdapterDescriptor(debugSession: vscode.DebugSession, executable: vscode.DebugAdapterExecutable | undefined): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
    const session = this._sessionManager.createSession(this._context, debugSession, debugAdapter => {
      this._onAdapterAddedEmitter.fire(debugAdapter);
    });
    this._sessions.set(debugSession.id, session);
    return session.descriptor();
  }

  sourceForUri(uri: vscode.Uri): { adapter: DebugAdapter | undefined, source: Source | undefined } {
    const query = queryString.parse(uri.query);
    const ref: Dap.Source = { path: uri.path, sourceReference: +(query['ref'] as string) };
    const sessionId = query['session'] as string;
    const session = this._sessions.get(sessionId);
    const adapter = session && session.debugAdapter();
    if (adapter)
      return { adapter, source: adapter.sourceContainer.source(ref) };
    return { adapter: undefined, source: undefined };
  }

  dispose() {
    for (const session of this._sessions.values()) {
      if (session.debugAdapter())
        this._onAdapterRemovedEmitter.fire(session.debugAdapter()!);
      session.dispose();
    }
    this._sessions.clear();
    this._sessionManager.dispose();
    for (const disposable of this._disposables)
      disposable.dispose();
    this._disposables = [];
  }
}
