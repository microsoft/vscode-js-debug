// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Transport } from './transport';
import { EventEmitter } from '../common/events';
import Cdp from './api';
import { RawTelemetryReporter, TelemetryReporter } from '../telemetry/telemetryReporter';
import { HighResolutionTime } from '../utils/performance';

interface ProtocolCommand {
  id: number;
  method: string;
  params: object;
  sessionId?: string;
}

interface ProtocolError {
  message: string;
  data: any;
}

interface ProtocolResponse {
  id?: number;
  method?: string;
  params?: object;
  result?: object;
  error?: ProtocolError;
  sessionId?: string;
}

interface ProtocolCallback {
  resolve: (o: object) => void;
  reject: (e: Error) => void;
  from: Error;
  method: string;
}

export default class Connection {
  private _lastId: number;
  private _transport: Transport;
  private _sessions: Map<string, CDPSession>;
  private _closed: boolean;
  private _rootSession: CDPSession;
  private _logPath?: string;
  private _logPrefix = '';
  private _onDisconnectedEmitter = new EventEmitter<void>();
  readonly onDisconnected = this._onDisconnectedEmitter.event;
  private readonly _telemetryReporter: TelemetryReporter;

  constructor(transport: Transport, rawTelemetryReporter: RawTelemetryReporter) {
    this._lastId = 0;
    this._transport = transport;
    this._transport.onmessage = this._onMessage.bind(this);
    this._transport.onclose = this._onTransportClose.bind(this);
    this._sessions = new Map();
    this._closed = false;
    this._rootSession = new CDPSession(this, '');
    this._sessions.set('', this._rootSession);
    this._telemetryReporter = TelemetryReporter.cdp(rawTelemetryReporter);
  }

  setLogConfig(prefix: string, path?: string) {
    this._logPrefix = prefix;
    this._logPath = path;
  }

  rootSession(): Cdp.Api {
    return this._rootSession.cdp();
  }

  session(sessionId: string): Cdp.Api {
    return this._sessions.get(sessionId)!.cdp();
  }

  _send(method: string, params: object | undefined = {}, sessionId: string): number {
    const id = ++this._lastId;
    const message: ProtocolCommand = { id, method, params };
    if (sessionId)
      message.sessionId = sessionId;
    const messageString = JSON.stringify(message);
    if (this._logPath)
      require('fs').appendFileSync(this._logPath, `SEND ► [${this._logPrefix}] ${messageString}\n`);
    this._transport.send(messageString);
    return id;
  }

  async _onMessage(message: string, receivedTime: HighResolutionTime) {
    if (this._logPath)
      require('fs').appendFileSync(this._logPath, `◀ RECV [${this._logPrefix}] ${message}\n`);
    const object = JSON.parse(message);

    const session = this._sessions.get(object.sessionId || '');
    if (session) {
      const eventName = object.method;
      try {
        session._onMessage(object);
        if (eventName)
          this._telemetryReporter.reportSuccess(eventName, receivedTime);
      } catch (error) {
        if (eventName)
          this._telemetryReporter.reportError(eventName, receivedTime, error);
      }
    } else {
      throw new Error(`Unknown session id: ${object.sessionId}`)
    }
  }

  _onTransportClose() {
    if (this._closed)
      return;
    this._closed = true;
    this._transport.onmessage = undefined;
    this._transport.onclose = undefined;
    for (const session of this._sessions.values())
      session._onClose();
    this._sessions.clear();
    this._onDisconnectedEmitter.fire();
  }

  close() {
    this._onTransportClose();
    this._transport.close();
  }

  isClosed(): boolean {
    return this._closed;
  }

  createSession(sessionId: Cdp.Target.SessionID): Cdp.Api {
    const session = new CDPSession(this, sessionId);
    this._sessions.set(sessionId, session);
    return session.cdp();
  }

  disposeSession(sessionId: Cdp.Target.SessionID) {
    const session = this._sessions.get(sessionId);
    if (!session)
      return;
    session._onClose();
    this._sessions.delete(session.sessionId());
  }
}

// Node versions before 12 do not guarantee relative order of tasks and microstasks.
// We artificially queue protocol messages to achieve this.
const needsReordering = +process.version.substring(1).split('.')[0] <= 12;

class CDPSession {
  private _connection?: Connection;
  private _callbacks: Map<number, ProtocolCallback>;
  private _sessionId: string;
  private _cdp: Cdp.Api;
  private _queue: ProtocolResponse[] = [];
  private _listeners = new Map<string, Set<(params: any) => void>>();
  private paused = false;

  constructor(connection: Connection, sessionId: string) {
    this._callbacks = new Map();
    this._connection = connection;
    this._sessionId = sessionId;
    this._cdp = this._createApi();
  }

  public pause() {
    this.paused = true;
  }

  public resume() {
    if (!this.paused) {
      return;
    }

    this.paused = false;
    const toSend = this._queue;
    this._queue = [];
    for (const item of toSend) {
      this._processResponse(item);
    }
  }

  cdp(): Cdp.Api {
    return this._cdp;
  }

  sessionId(): Cdp.Target.SessionID {
    return this._sessionId;
  }

  _createApi(): Cdp.Api {
    return new Proxy({}, {
      get: (_target, agentName: string, _receiver) => {
        if (agentName === 'pause')
          return () => this.pause();
        if (agentName === 'resume')
          return () => this.resume();

        return new Proxy({}, {
          get: (_target, methodName: string, _receiver) => {
            if (methodName === 'then')
              return;
            if (methodName === 'on')
              return (eventName: string, listener: (params: any) => void) => this._on(`${agentName}.${eventName}`, listener);
            if (methodName === 'off')
              return (eventName: string, listener: (params: any) => void) => this._off(`${agentName}.${eventName}`, listener);
            return (params: object | undefined) => this._send(`${agentName}.${methodName}`, params);
          }
        });
      },
    }) as Cdp.Api;
  }

  _on(method: string, listener: (params: any) => void): void {
    if (!this._listeners.has(method))
      this._listeners.set(method, new Set());
    this._listeners.get(method)!.add(listener);
  }

  _off(method: string, listener: (params: any) => void): void {
    const listeners = this._listeners.get(method);
    if (listeners)
      listeners.delete(listener);
  }

  _send(method: string, params: object | undefined = {}): Promise<object | undefined> {
    return this._sendOrDie(method, params).catch(e => undefined);
  }

  _sendOrDie(method: string, params: object | undefined = {}): Promise<object | undefined> {
    if (!this._connection)
      return Promise.reject(new Error(`Protocol error (${method}): Session closed. Most likely the target has been closed.`));
    const id = this._connection._send(method, params, this._sessionId);
    return new Promise((resolve, reject) => {
      this._callbacks.set(id, { resolve, reject, from: new Error(), method });
    });
  }

  _onMessage(object: ProtocolResponse) {
    if (object.id) {
      this._processResponse(object);
    }

    // If we're paused, queue events but still process responses to avoid hanging.
    if (this.paused) {
      this._queue.push(object);
      return;
    }

    if (!needsReordering) {
      this._processResponse(object);
      return;
    }

    this._queue.push(object);
    if (this._queue.length === 1) {
      this._processQueue();
    }
  }

  _processQueue() {
    setTimeout(() => {
      if (this.paused || this._queue.length === 0) {
        return;
      }

      const object = this._queue.shift()!;
      this._processResponse(object);
      if (this._queue.length) {
        this._processQueue();
      }
    }, 0);
  }

  _processResponse(object: ProtocolResponse) {
    if (object.id && this._callbacks.has(object.id)) {
      const callback = this._callbacks.get(object.id)!;
      this._callbacks.delete(object.id);
      if (object.error) {
        callback.from.message = `Protocol error (${object.method}): ${object.error.message}`;
        if (object.error)
          callback.from.message += ` - ${JSON.stringify(object.error)}`;
        callback.reject(callback.from);
      } else {
        callback.resolve(object.result!);
      }
    } else {
      const listeners = this._listeners.get(object.method!);
      for (const listener of listeners || [])
        listener(object.params);
    }
  }

  async detach() {
    if (!this._connection)
      throw new Error(`Session already detached. Most likely the target has been closed.`);
    await this._connection._send('Target.detachFromTarget', {}, this._sessionId);
  }

  isClosed(): boolean {
    return !this._connection;
  }

  _onClose() {
    for (const callback of this._callbacks.values()) {
      callback.from.message = `Protocol error (${callback.method}): Target closed.`;
      callback.reject(callback.from);
    }
    this._callbacks.clear();
    this._connection = undefined;
  }
}
