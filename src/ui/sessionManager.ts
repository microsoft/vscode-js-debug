/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as net from 'net';
import * as vscode from 'vscode';
import { Binder, IBinderDelegate } from '../binder';
import DapConnection from '../dap/connection';
import { BrowserLauncher } from '../targets/browser/browserLauncher';
import { NodeLauncher } from '../targets/node/nodeLauncher';
import { BrowserAttacher } from '../targets/browser/browserAttacher';
import { ITarget } from '../targets/targets';
import { IDisposable } from '../common/events';
import { checkVersion } from './version';
import { SubprocessProgramLauncher } from '../targets/node/subprocessProgramLauncher';
import { Contributions } from '../common/contributionUtils';
import { TerminalProgramLauncher } from '../targets/node/terminalProgramLauncher';
import { NodeAttacher } from '../targets/node/nodeAttacher';
import { ExtensionHostLauncher } from '../targets/node/extensionHostLauncher';
import { ExtensionHostAttacher } from '../targets/node/extensionHostAttacher';
import { TerminalNodeLauncher } from '../targets/node/terminalNodeLauncher';
import { NodePathProvider } from '../targets/node/nodePathProvider';
import { assert } from '../common/logging/logger';

export class Session implements IDisposable {
  public readonly debugSession: vscode.DebugSession;
  public readonly connection: DapConnection;
  private _server: net.Server;
  private _binder?: Binder;
  private _onTargetNameChanged?: IDisposable;

  constructor(debugSession: vscode.DebugSession) {
    this.debugSession = debugSession;
    this.connection = new DapConnection();
    this._server = net
      .createServer(async socket => {
        this.connection.init(socket, socket);
      })
      .listen(0);
  }

  listenToTarget(target: ITarget) {
    if (checkVersion('1.39.0'))
      this._onTargetNameChanged = target.onNameChanged(() => {
        this.debugSession.name = target.name();
      });
  }

  createBinder(context: vscode.ExtensionContext, delegate: IBinderDelegate) {
    const pathProvider = new NodePathProvider();
    const launchers = [
      new ExtensionHostAttacher(pathProvider),
      new ExtensionHostLauncher(pathProvider),
      new TerminalNodeLauncher(pathProvider),
      new NodeLauncher(pathProvider, [
        new SubprocessProgramLauncher(),
        new TerminalProgramLauncher(),
      ]),
      new NodeAttacher(pathProvider),
      new BrowserLauncher(context.storagePath || context.extensionPath),
      new BrowserAttacher(),
    ];
    this._binder = new Binder(delegate, this.connection, launchers, this.debugSession.id);
  }

  descriptor(): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
    return new vscode.DebugAdapterServer((this._server.address() as net.AddressInfo).port);
  }

  dispose() {
    if (this._binder) this._binder.dispose();
    if (this._onTargetNameChanged) this._onTargetNameChanged.dispose();
    this._server.close();
  }
}

export class SessionManager
  implements vscode.DebugAdapterDescriptorFactory, IDisposable, IBinderDelegate {
  private _disposables: IDisposable[] = [];
  private _sessions = new Map<string, Session>();

  private _pendingTarget = new Map<string, ITarget>();
  private _sessionForTarget = new Map<ITarget, Promise<Session>>();
  private _sessionForTargetCallbacks = new Map<
    ITarget,
    { fulfill: (session: Session) => void; reject: (error: Error) => void }
  >();

  constructor(private readonly _context: vscode.ExtensionContext) {}

  public terminate(debugSession: vscode.DebugSession) {
    const session = this._sessions.get(debugSession.id);
    this._sessions.delete(debugSession.id);
    if (session) session.dispose();
  }

  createDebugAdapterDescriptor(
    debugSession: vscode.DebugSession,
  ): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
    const session = new Session(debugSession);
    if (debugSession.configuration['__pendingTargetId']) {
      const pendingTargetId = debugSession.configuration['__pendingTargetId'] as string;
      const target = this._pendingTarget.get(pendingTargetId);
      if (!assert(target, `Cannot find target ${pendingTargetId}`)) {
        return;
      }

      this._pendingTarget.delete(pendingTargetId);
      session.listenToTarget(target);
      const callbacks = this._sessionForTargetCallbacks.get(target);
      this._sessionForTargetCallbacks.delete(target);
      if (callbacks) callbacks.fulfill(session);
    } else {
      session.createBinder(this._context, this);
    }
    this._sessions.set(debugSession.id, session);
    return session.descriptor();
  }

  async acquireDap(target: ITarget): Promise<DapConnection> {
    const session = await this._createSession(target);
    return session.connection;
  }

  _createSession(target: ITarget): Promise<Session> {
    const existingSession = this._sessionForTarget.get(target);
    if (existingSession) {
      return existingSession;
    }

    const newSession = new Promise<Session>(async (fulfill, reject) => {
      this._pendingTarget.set(target.id(), target);
      this._sessionForTargetCallbacks.set(target, { fulfill, reject });

      let parentDebugSession: vscode.DebugSession;
      const parentTarget = target.parent();
      if (parentTarget) {
        const parentSession = await this._createSession(parentTarget);
        parentDebugSession = parentSession.debugSession;
      } else {
        parentDebugSession = this._sessions.get(target.targetOrigin() as string)!.debugSession;
      }

      const config = {
        type: Contributions.ChromeDebugType,
        name: target.name(),
        request: 'attach',
        __pendingTargetId: target.id(),
      };

      if (checkVersion('1.39.0')) {
        vscode.debug.startDebugging(parentDebugSession.workspaceFolder, config, {
          parentSession: parentDebugSession,
          consoleMode: vscode.DebugConsoleMode.MergeWithParent,
        });
      } else {
        vscode.debug.startDebugging(parentDebugSession.workspaceFolder, config, parentDebugSession);
      }
    });

    this._sessionForTarget.set(target, newSession);
    return newSession;
  }

  initAdapter(): Promise<boolean> {
    return Promise.resolve(false);
  }

  releaseDap(target: ITarget) {
    this._sessionForTarget.delete(target);
    const callbacks = this._sessionForTargetCallbacks.get(target);
    if (callbacks) callbacks.reject(new Error('Target gone'));
    this._sessionForTargetCallbacks.delete(target);
  }

  dispose() {
    for (const session of this._sessions.values()) session.dispose();
    this._sessions.clear();
    this._pendingTarget.clear();
    this._sessionForTarget.clear();
    this._sessionForTargetCallbacks.clear();
    for (const disposable of this._disposables) disposable.dispose();
    this._disposables = [];
  }
}
