/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { Binder, IBinderDelegate } from './binder';
import DapConnection from './dap/connection';
import { ITarget } from './targets/targets';
import { IDisposable, IEvent, EventEmitter } from './common/events';
import { DebugType } from './common/contributionUtils';
import { TargetOrigin } from './targets/targetOrigin';
import { TelemetryReporter } from './telemetry/telemetryReporter';
import { ILogger } from './common/logging';
import { Container } from 'inversify';
import { createTopLevelSessionContainer } from './ioc';
import { IChromeAttachConfiguration } from './configuration';
import { IDapTransport } from './dap/transport';

/**
 * Interface for abstracting the details of a particular (e.g. vscode vs VS) debug session
 */
export interface IDebugSessionLike {
  id: string;
  name: string;
}

/**
 * Function signature for defining how to launch a new debug session on the host
 */
export type SessionLauncher<T extends IDebugSessionLike> = (
  parentSession: Session<T>,
  target: ITarget,
  config: Partial<IChromeAttachConfiguration>,
) => void;

/**
 * Encapsulates a running debug session under DAP
 * @template TSessionImpl Type of the mplementation specific debug session
 */
export class Session<TSessionImpl extends IDebugSessionLike> implements IDisposable {
  public readonly connection: DapConnection;
  protected readonly telemetryReporter = new TelemetryReporter();
  private _onTargetNameChanged = new EventEmitter<string>();
  public onTargetNameChanged: IEvent<string> = this._onTargetNameChanged.event;

  private subscription?: IDisposable;

  constructor(
    public readonly debugSession: TSessionImpl,
    transport: IDapTransport,
    public readonly logger: ILogger,
  ) {
    transport.setLogger(logger);
    this.connection = new DapConnection(transport, this.telemetryReporter, this.logger);
  }

  listenToTarget(target: ITarget) {
    this.subscription = target.onNameChanged(() => this._onTargetNameChanged.fire(target.name()));
  }

  dispose() {
    this.subscription?.dispose();
  }
}

export class RootSession<TSessionImpl extends IDebugSessionLike> extends Session<TSessionImpl> {
  private _binder?: Binder;

  constructor(
    public readonly debugSession: TSessionImpl,
    transport: IDapTransport,
    private readonly services: Container,
  ) {
    super(debugSession, transport, services.get(ILogger));
  }

  createBinder(delegate: IBinderDelegate) {
    this._binder = new Binder(
      delegate,
      this.connection,
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

export class SessionManager<TSessionImpl extends IDebugSessionLike>
  implements IDisposable, IBinderDelegate {
  private _disposables: IDisposable[] = [];
  private _sessions = new Map<string, Session<TSessionImpl>>();

  private _pendingTarget = new Map<string, { target: ITarget; parent: Session<TSessionImpl> }>();
  private _sessionForTarget = new Map<ITarget, Promise<Session<TSessionImpl>>>();
  private _sessionForTargetCallbacks = new Map<
    ITarget,
    { fulfill: (session: Session<TSessionImpl>) => void; reject: (error: Error) => void }
  >();

  constructor(
    private readonly globalContainer: Container,
    private readonly sessionLauncher: SessionLauncher<TSessionImpl>,
  ) {}

  public terminate(debugSession: TSessionImpl) {
    const session = this._sessions.get(debugSession.id);
    this._sessions.delete(debugSession.id);
    if (session) session.dispose();
  }

  /**
   * @inheritdoc
   */
  public createNewSession(
    debugSession: TSessionImpl,
    config: any,
    transport: IDapTransport,
  ): Session<TSessionImpl> {
    let session: Session<TSessionImpl>;

    const pendingTargetId: string | undefined = config.__pendingTargetId;
    if (pendingTargetId) {
      const pending = this._pendingTarget.get(pendingTargetId);
      if (!pending) {
        throw new Error(`Cannot find target ${pendingTargetId}`);
      }

      const { target, parent } = pending;
      session = new Session<TSessionImpl>(debugSession, transport, parent.logger);

      this._pendingTarget.delete(pendingTargetId);
      session.listenToTarget(target);
      const callbacks = this._sessionForTargetCallbacks.get(target);
      this._sessionForTargetCallbacks.delete(target);
      callbacks?.fulfill?.(session);
    } else {
      const root = new RootSession(
        debugSession,
        transport,
        createTopLevelSessionContainer(this.globalContainer),
      );
      root.createBinder(this);
      session = root;
    }

    this._sessions.set(debugSession.id, session);
    return session;
  }

  /**
   * @inheritdoc
   */
  public async acquireDap(target: ITarget): Promise<DapConnection> {
    const session = await this.launchNewSession(target);
    return session.connection;
  }

  /**
   * Creates a debug session for the given target.
   */
  public launchNewSession(target: ITarget): Promise<Session<TSessionImpl>> {
    const existingSession = this._sessionForTarget.get(target);
    if (existingSession) {
      return existingSession;
    }

    const newSession = new Promise<Session<TSessionImpl>>(async (fulfill, reject) => {
      let parentSession: Session<TSessionImpl> | undefined;
      const parentTarget = target.parent();
      if (parentTarget) {
        parentSession = await this.launchNewSession(parentTarget);
      } else {
        parentSession = this._sessions.get(target.targetOrigin().id);
      }

      if (!parentSession) {
        throw new Error('Expected to get a parent debug session for target');
      }

      this._pendingTarget.set(target.id(), { target, parent: parentSession });
      this._sessionForTargetCallbacks.set(target, { fulfill, reject });

      const config: Partial<IChromeAttachConfiguration> = {
        type: DebugType.Chrome,
        name: target.name(),
        request: 'attach',
        __pendingTargetId: target.id(),
      };

      this.sessionLauncher(parentSession, target, config);
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
