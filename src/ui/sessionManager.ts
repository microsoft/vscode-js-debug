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
import { SubprocessProgramLauncher } from '../targets/node/subprocessProgramLauncher';
import { Contributions } from '../common/contributionUtils';
import { TerminalProgramLauncher } from '../targets/node/terminalProgramLauncher';
import { NodeAttacher } from '../targets/node/nodeAttacher';
import { ExtensionHostLauncher } from '../targets/node/extensionHostLauncher';
import { ExtensionHostAttacher } from '../targets/node/extensionHostAttacher';
import { TerminalNodeLauncher } from '../targets/node/terminalNodeLauncher';
import { NodePathProvider } from '../targets/node/nodePathProvider';
import { assert } from '../common/logging/logger';
import { DelegateLauncherFactory } from '../targets/delegate/delegateLauncherFactory';
import { TargetOrigin } from '../targets/targetOrigin';
import { TelemetryReporter } from '../telemetry/telemetryReporter';
import { TopLevelServiceFactory, IServiceFactory } from '../services';

export class Session implements IDisposable {
  public readonly debugSession: vscode.DebugSession;
  public readonly connection: DapConnection;
  private readonly telemetryReporter = new TelemetryReporter();
  private _server: net.Server;
  private _binder?: Binder;
  private _onTargetNameChanged?: IDisposable;

  constructor(debugSession: vscode.DebugSession, public readonly services: IServiceFactory) {
    this.debugSession = debugSession;
    this.connection = new DapConnection(this.telemetryReporter);
    this._server = net
      .createServer(async socket => {
        this.connection.init(socket, socket);
      })
      .listen(0);
  }

  listenToTarget(target: ITarget) {
    this._onTargetNameChanged = target.onNameChanged(() => {
      this.debugSession.name = target.name();
    });
  }

  createBinder(
    context: vscode.ExtensionContext,
    delegateLauncher: DelegateLauncherFactory,
    delegate: IBinderDelegate,
  ) {
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
      delegateLauncher.createLauncher(),
    ];
    this._binder = new Binder(
      delegate,
      this.connection,
      launchers,
      this.services,
      this.telemetryReporter,
      new TargetOrigin(this.debugSession.id),
    );
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
    {
      services: IServiceFactory;
      fulfill: (session: Session) => void;
      reject: (error: Error) => void;
    }
  >();

  constructor(
    private readonly _context: vscode.ExtensionContext,
    private readonly launcherDelegate: DelegateLauncherFactory,
  ) {}

  public terminate(debugSession: vscode.DebugSession) {
    const session = this._sessions.get(debugSession.id);
    this._sessions.delete(debugSession.id);
    if (session) session.dispose();
  }

  /**
   * @inheritdoc
   */
  public createDebugAdapterDescriptor(
    debugSession: vscode.DebugSession,
  ): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
    const pendingTargetId: string | undefined = debugSession.configuration.__pendingTargetId;
    let session: Session;
    if (pendingTargetId) {
      const target = this._pendingTarget.get(pendingTargetId);
      if (!assert(target, `Cannot find target ${pendingTargetId}`)) {
        return;
      }

      const callbacks = this._sessionForTargetCallbacks.get(target);
      if (!assert(callbacks, `Cannot find callbacks for target ${pendingTargetId}`)) {
        return;
      }

      session = new Session(debugSession, callbacks.services);
      this._pendingTarget.delete(pendingTargetId);
      session.listenToTarget(target);
      this._sessionForTargetCallbacks.delete(target);
      callbacks.fulfill(session);
    } else {
      session = new Session(debugSession, new TopLevelServiceFactory());
      session.createBinder(this._context, this.launcherDelegate, this);
    }
    this._sessions.set(debugSession.id, session);
    return session.descriptor();
  }

  /**
   * @inheritdoc
   */
  public async acquireDap(target: ITarget): Promise<DapConnection> {
    const session = await this.createSession(target);
    return session.connection;
  }

  /**
   * Creates a debug session for the given target.
   */
  public createSession(target: ITarget): Promise<Session> {
    const existingSession = this._sessionForTarget.get(target);
    if (existingSession) {
      return existingSession;
    }

    const newSession = new Promise<Session>(async (fulfill, reject) => {
      let parentSession: Session | undefined;
      const parentTarget = target.parent();
      if (parentTarget) {
        parentSession = await this.createSession(parentTarget);
      } else {
        parentSession = this._sessions.get(target.targetOrigin().id);
      }
      if (!assert(parentSession, 'Expected to get a parent debug session for target')) {
        return;
      }

      this._pendingTarget.set(target.id(), target);
      this._sessionForTargetCallbacks.set(target, {
        services: parentSession.services.child,
        fulfill,
        reject,
      });

      const config = {
        type: Contributions.ChromeDebugType,
        name: target.name(),
        request: 'attach',
        __pendingTargetId: target.id(),
      };

      vscode.debug.startDebugging(parentSession.debugSession.workspaceFolder, config, {
        parentSession: parentSession.debugSession,
        consoleMode: vscode.DebugConsoleMode.MergeWithParent,
      });
    });

    this._sessionForTarget.set(target, newSession);
    return newSession;
  }

  /**
   * @inheritdoc
   */
  public initAdapter(): Promise<boolean> {
    return Promise.resolve(false);
  }

  /**
   * @inheritdoc
   */
  public releaseDap(target: ITarget) {
    this._sessionForTarget.delete(target);
    const callbacks = this._sessionForTargetCallbacks.get(target);
    if (callbacks) callbacks.reject(new Error('Target gone'));
    this._sessionForTargetCallbacks.delete(target);
  }

  /**
   * @inheritdoc
   */
  public dispose() {
    for (const session of this._sessions.values()) session.dispose();
    this._sessions.clear();
    this._pendingTarget.clear();
    this._sessionForTarget.clear();
    this._sessionForTargetCallbacks.clear();
    for (const disposable of this._disposables) disposable.dispose();
    this._disposables = [];
  }
}
