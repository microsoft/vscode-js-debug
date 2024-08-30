/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { Container } from 'inversify';
import { DebugConfiguration } from 'vscode';
import { DebugAdapter } from './adapter/debugAdapter';
import { Binder, IBinderDelegate } from './binder';
import { DebugType } from './common/contributionUtils';
import { DisposableList } from './common/disposable';
import { IDisposable } from './common/events';
import { ILogger } from './common/logging';
import { IMandatedConfiguration, IPseudoAttachConfiguration } from './configuration';
import DapConnection from './dap/connection';
import { IDapTransport } from './dap/transport';
import { createTopLevelSessionContainer } from './ioc';
import { SessionSubStates } from './ioc-extras';
import { TargetOrigin } from './targets/targetOrigin';
import { ILauncher, ITarget } from './targets/targets';
import { ITelemetryReporter } from './telemetry/telemetryReporter';

/**
 * Interface for abstracting the details of a particular (e.g. vscode vs VS) debug session
 */
export interface IDebugSessionLike {
  readonly id: string;
  name: string;
  readonly configuration: DebugConfiguration;
}

/**
 * Interface for defining how to launch a new debug session on the host IDE
 */

export interface ISessionLauncher<T extends IDebugSessionLike> {
  launch(parentSession: Session<T>, target: ITarget, config: IPseudoAttachConfiguration): void;
}

/**
 * Encapsulates a running debug session under DAP
 * @template TSessionImpl Type of the mplementation specific debug session
 */
export class Session<TSessionImpl extends IDebugSessionLike> implements IDisposable {
  public readonly connection: DapConnection;
  private readonly subscriptions = new DisposableList();

  constructor(
    public readonly debugSession: TSessionImpl,
    transport: IDapTransport | DapConnection,
    public readonly logger: ILogger,
    public readonly sessionStates: SessionSubStates,
    private readonly parent?: Session<TSessionImpl>,
  ) {
    if (transport instanceof DapConnection) {
      this.connection = transport;
    } else {
      transport.setLogger(logger);
      this.connection = new DapConnection(transport, this.logger);
    }
  }

  listenToTarget(target: ITarget) {
    this.subscriptions.push(
      target.onNameChanged(() => this.setName(target)),
      this.sessionStates.onAdd(
        ([sessionId]) => sessionId === this.debugSession.id && this.setName(target),
      ),
      this.sessionStates.onRemove(
        ([sessionId]) => sessionId === this.debugSession.id && this.setName(target),
      ),
    );

    this.setName(target);
  }

  dispose() {
    this.subscriptions.dispose();
  }

  private setName(target: ITarget) {
    const substate = this.sessionStates.get(this.debugSession.id);
    let name = target.name();
    if (this.parent instanceof RootSession) {
      name = `${this.parent.debugSession.name}: ${name}`;
    }

    this.debugSession.name = substate ? `${name} (${substate})` : name;
  }
}

export class RootSession<TSessionImpl extends IDebugSessionLike> extends Session<TSessionImpl> {
  private _binder?: Binder;

  constructor(
    public readonly debugSession: TSessionImpl,
    transport: IDapTransport | DapConnection,
    private readonly services: Container,
  ) {
    super(debugSession, transport, services.get(ILogger), services.get(SessionSubStates));
    this.connection.attachTelemetry(services.get(ITelemetryReporter));
  }

  get binder() {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return this._binder!;
  }

  createBinder(delegate: IBinderDelegate) {
    this._binder = new Binder(
      delegate,
      this.connection,
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
  implements IDisposable, IBinderDelegate
{
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
    private readonly sessionLauncher: ISessionLauncher<TSessionImpl>,
  ) {}

  public terminate(debugSession: TSessionImpl) {
    const session = this._sessions.get(debugSession.id);
    this._sessions.delete(debugSession.id);
    if (session) session.dispose();
  }

  /**
   * Gets whether the pending target ID exists.
   */
  public hasPendingTargetId(targetId: string) {
    return this._pendingTarget.has(targetId);
  }

  public createNewRootSession(
    debugSession: TSessionImpl,
    transport: IDapTransport | DapConnection,
  ) {
    const root = new RootSession(
      debugSession,
      transport,
      createTopLevelSessionContainer(this.globalContainer),
    );
    root.createBinder(this);
    this._sessions.set(debugSession.id, root);
    return root;
  }

  /**
   * @inheritdoc
   */
  public createNewChildSession(
    debugSession: TSessionImpl,
    pendingTargetId: string,
    transport: IDapTransport | DapConnection,
  ): Session<TSessionImpl> {
    const pending = this._pendingTarget.get(pendingTargetId);
    if (!pending) {
      throw new Error(`Cannot find target ${pendingTargetId}`);
    }

    const { target, parent } = pending;
    const session = new Session<TSessionImpl>(
      debugSession,
      transport,
      parent.logger,
      parent.sessionStates,
      parent,
    );

    this._pendingTarget.delete(pendingTargetId);
    session.debugSession.name = target.name();
    session.listenToTarget(target);
    const callbacks = this._sessionForTargetCallbacks.get(target);
    this._sessionForTargetCallbacks.delete(target);
    callbacks?.fulfill?.(session);
    this._sessions.set(debugSession.id, session);
    return session;
  }

  /**
   * @inheritdoc
   */
  public async acquireDap(target: ITarget): Promise<DapConnection> {
    const session = await this.getOrLaunchSession(target);
    return session.connection;
  }

  /**
   * Creates a debug session for the given target.
   */
  public getOrLaunchSession(target: ITarget): Promise<Session<TSessionImpl>> {
    const existingSession = this._sessionForTarget.get(target);
    if (existingSession) {
      return existingSession;
    }

    const newSession = new Promise<Session<TSessionImpl>>(async (fulfill, reject) => {
      let parentSession: Session<TSessionImpl> | undefined;
      const parentTarget = target.parent();
      if (parentTarget) {
        parentSession = await this.getOrLaunchSession(parentTarget);
      } else {
        parentSession = this._sessions.get(target.targetOrigin().id);
      }

      if (!parentSession) {
        throw new Error('Expected to get a parent debug session for target');
      }

      this._pendingTarget.set(target.id(), { target, parent: parentSession });
      this._sessionForTargetCallbacks.set(target, { fulfill, reject });

      const parentConfig = parentSession.debugSession.configuration as IMandatedConfiguration;
      const config: IPseudoAttachConfiguration = {
        // see https://github.com/microsoft/vscode/issues/98993
        type: parentConfig.type === DebugType.ExtensionHost
          ? DebugType.Chrome
          : (parentConfig.type as DebugType),
        name: target.name(),
        request: parentSession.debugSession.configuration.request as 'attach' | 'launch',
        __pendingTargetId: target.id(),
        // fix for https://github.com/microsoft/vscode/issues/102296
        preRestartTask: parentConfig.preRestartTask ?? parentConfig.postDebugTask,
        postRestartTask: parentConfig.postRestartTask ?? parentConfig.preLaunchTask,
      };

      this.sessionLauncher.launch(parentSession, target, config);
    });

    this._sessionForTarget.set(target, newSession);
    return newSession;
  }

  /**
   * @inheritdoc
   */
  public initAdapter(
    _debugAdapter: DebugAdapter,
    _target: ITarget,
    _launcher: ILauncher,
  ): Promise<boolean> {
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
