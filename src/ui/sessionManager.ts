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
import { DelegateLauncherFactory } from '../targets/delegate/delegateLauncherFactory';
import { TargetOrigin } from '../targets/targetOrigin';
import { TelemetryReporter } from '../telemetry/telemetryReporter';
import { TopLevelServiceFactory } from '../services';
import { ILogger } from '../common/logging';

class Session implements IDisposable {
  public readonly connection: DapConnection;
  protected readonly telemetryReporter = new TelemetryReporter();
  private readonly server: net.Server;
  private _onTargetNameChanged?: IDisposable;

  constructor(public readonly debugSession: vscode.DebugSession, public readonly logger: ILogger) {
    this.connection = new DapConnection(this.telemetryReporter, logger);
    this.server = net
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

  descriptor(): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
    return new vscode.DebugAdapterServer((this.server.address() as net.AddressInfo).port);
  }

  dispose() {
    this._onTargetNameChanged?.dispose?.();
    this.server.close();
  }
}

class RootSession extends Session {
  private _binder?: Binder;

  constructor(
    debugSession: vscode.DebugSession,
    private readonly services = new TopLevelServiceFactory(),
  ) {
    super(debugSession, services.logger);
  }

  createBinder(
    context: vscode.ExtensionContext,
    delegateLauncher: DelegateLauncherFactory,
    delegate: IBinderDelegate,
  ) {
    const pathProvider = new NodePathProvider();
    const launchers = [
      new ExtensionHostAttacher(pathProvider, this.services.logger),
      new ExtensionHostLauncher(pathProvider, this.services.logger),
      new TerminalNodeLauncher(pathProvider, this.services.logger),
      new NodeLauncher(pathProvider, this.services.logger, [
        new SubprocessProgramLauncher(this.services.logger),
        new TerminalProgramLauncher(this.services.logger),
      ]),
      new NodeAttacher(pathProvider, this.services.logger),
      new BrowserLauncher(context.storagePath || context.extensionPath, this.services.logger),
      new BrowserAttacher(this.services.logger),
      delegateLauncher.createLauncher(),
    ];
    this._binder = new Binder(
      delegate,
      this.connection,
      launchers,
      this.telemetryReporter,
      this.services,
      new TargetOrigin(this.debugSession.id),
    );
  }

  dispose() {
    super.dispose();
    this._binder?.dispose?.();
  }
}

export class SessionManager
  implements vscode.DebugAdapterDescriptorFactory, IDisposable, IBinderDelegate {
  private _disposables: IDisposable[] = [];
  private _sessions = new Map<string, Session>();

  private _pendingTarget = new Map<string, { target: ITarget; parent: Session }>();
  private _sessionForTarget = new Map<ITarget, Promise<Session>>();
  private _sessionForTargetCallbacks = new Map<
    ITarget,
    { fulfill: (session: Session) => void; reject: (error: Error) => void }
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
    let session: Session;

    const pendingTargetId: string | undefined = debugSession.configuration.__pendingTargetId;
    if (pendingTargetId) {
      const pending = this._pendingTarget.get(pendingTargetId);
      if (!pending) {
        throw new Error(`Cannot find target ${pendingTargetId}`);
      }

      const { target, parent } = pending;
      session = new Session(debugSession, parent.logger);

      this._pendingTarget.delete(pendingTargetId);
      session.listenToTarget(target);
      const callbacks = this._sessionForTargetCallbacks.get(target);
      this._sessionForTargetCallbacks.delete(target);
      callbacks?.fulfill?.(session);
    } else {
      const root = new RootSession(debugSession);
      root.createBinder(this._context, this.launcherDelegate, this);
      session = root;
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

      if (!parentSession) {
        throw new Error('Expected to get a parent debug session for target');
      }

      this._pendingTarget.set(target.id(), { target, parent: parentSession });
      this._sessionForTargetCallbacks.set(target, { fulfill, reject });

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
