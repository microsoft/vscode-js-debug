// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as net from 'net';
import * as vscode from 'vscode';
import { DebugAdapter } from './adapter/debugAdapter';
import { Binder, BinderDelegate } from './binder';
import DapConnection from './dap/connection';
import { BrowserLauncher } from './targets/browser/browserLauncher';
import { NodeLauncher } from './targets/node/nodeLauncher';
import { BrowserAttacher } from './targets/browser/browserAttacher';
import { Target } from './targets/targets';
import { Disposable } from './utils/eventUtils';
import { checkVersion } from './ui/version';
import { FileSourcePathResolver } from './common/sourcePathResolver';
import { TerminalProgramLauncher } from './ui/terminalProgramLauncher';

export class Session implements Disposable {
  _debugSession: vscode.DebugSession;
  private _server: net.Server;
  _debugAdapter?: DebugAdapter;
  private _binder?: Binder;
  private _onTargetNameChanged?: Disposable;

  constructor(context: vscode.ExtensionContext, debugSession: vscode.DebugSession, target: Target | undefined, binderDelegate: BinderDelegate | undefined, callback: (debugAdapter: DebugAdapter) => void) {
    this._debugSession = debugSession;
    if (target && checkVersion('1.39.0'))
      this._onTargetNameChanged = target.onNameChanged(() => debugSession.name = target.name());

    this._server = net.createServer(async socket => {
      let rootPath = vscode.workspace.rootPath;
      if (debugSession.workspaceFolder && debugSession.workspaceFolder.uri.scheme === 'file:')
        rootPath = debugSession.workspaceFolder.uri.path;

      const connection = new DapConnection(socket, socket);
      this._debugAdapter = new DebugAdapter(connection.dap(), rootPath, target ? target.sourcePathResolver() : new FileSourcePathResolver(rootPath));

      if (binderDelegate) {
        const launchers = [
          new NodeLauncher(rootPath, new TerminalProgramLauncher()),
          new BrowserLauncher(context.storagePath || context.extensionPath, rootPath),
          new BrowserAttacher(rootPath),
        ];
        this._binder = new Binder(binderDelegate, this._debugAdapter.dap, launchers, debugSession.id);
      }

      callback(this._debugAdapter);
    }).listen(0);
  }

  descriptor(): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
    return new vscode.DebugAdapterServer(this._server.address().port);
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

export class AdapterFactory implements vscode.DebugAdapterDescriptorFactory, Disposable, BinderDelegate {
  private _context: vscode.ExtensionContext;
  private _disposables: Disposable[] = [];
  private _sessions = new Map<string, Session>();

  private _pendingTarget = new Map<string, Target>();
  private _sessionForTarget = new Map<Target, Promise<Session>>();
  private _sessionForTargetCallbacks = new Map<Target, { fulfill: (session: Session) => void, reject: (error: Error) => void}>();

  constructor(context: vscode.ExtensionContext) {
    this._context = context;
    context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory('pwa', this));
    context.subscriptions.push(this);

    vscode.debug.onDidTerminateDebugSession(debugSession => {
      const session = this._sessions.get(debugSession.id);
      this._sessions.delete(debugSession.id);
      if (session)
        session.dispose();
    }, undefined, this._disposables);
  }

  createDebugAdapterDescriptor(debugSession: vscode.DebugSession, executable: vscode.DebugAdapterExecutable | undefined): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
    let session: Session;

    if (debugSession.configuration['__pendingTargetId']) {
      const pendingTargetId = debugSession.configuration['__pendingTargetId'] as string;
      const target = this._pendingTarget.get(pendingTargetId)!;
      this._pendingTarget.delete(pendingTargetId);

      session = new Session(this._context, debugSession, target, undefined, debugAdapter => {
        debugAdapter.dap.on('attach', async () => {
          const callbacks = this._sessionForTargetCallbacks.get(target);
          this._sessionForTargetCallbacks.delete(target);
          if (callbacks)
            callbacks.fulfill(session);
          return {};
        });
      });
    } else {
      session = new Session(this._context, debugSession, undefined, this, () => {});
    }

    this._sessions.set(debugSession.id, session);
    return session.descriptor();
  }

  async acquireDebugAdapter(target: Target): Promise<DebugAdapter> {
    const session = await this._createSession(target);
    return session._debugAdapter!;
  }

  _createSession(target: Target): Promise<Session> {
    if (!this._sessionForTarget.has(target)) {
      this._sessionForTarget.set(target, new Promise<Session>(async (fulfill, reject) => {
        this._pendingTarget.set(target.id(), target);
        this._sessionForTargetCallbacks.set(target, {fulfill, reject});

        let parentDebugSession: vscode.DebugSession;
        const parentTarget = target.parent();
        if (parentTarget) {
          const parentSession = await this._createSession(parentTarget);
          parentDebugSession = parentSession._debugSession;
        } else {
          parentDebugSession = this._sessions.get(target.targetOrigin() as string)!._debugSession;
        }

        const config = {
          type: 'pwa',
          name: target.name(),
          request: 'attach',
          __pendingTargetId: target.id()
        };

        if (checkVersion('1.39.0')) {
          vscode.debug.startDebugging(parentDebugSession.workspaceFolder, config, {
            parentSession: parentDebugSession,
            consoleMode: vscode.DebugConsoleMode.MergeWithParent
          });
        } else {
          vscode.debug.startDebugging(parentDebugSession.workspaceFolder, config, parentDebugSession);
        }
      }));
    }
    return this._sessionForTarget.get(target)!;
  }

  releaseDebugAdapter(target: Target, debugAdapter: DebugAdapter) {
    debugAdapter.dap.terminated({});
    this._sessionForTarget.delete(target);
    const callbacks = this._sessionForTargetCallbacks.get(target);
    if (callbacks)
      callbacks.reject(new Error('Target gone'));
    this._sessionForTargetCallbacks.delete(target);
  }

  dispose() {
    for (const session of this._sessions.values())
      session.dispose();
    this._sessions.clear();
    this._pendingTarget.clear();
    this._sessionForTarget.clear();
    this._sessionForTargetCallbacks.clear();
    for (const disposable of this._disposables)
      disposable.dispose();
    this._disposables = [];
  }
}
