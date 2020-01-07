/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { ITransport } from './transport';
import { EventEmitter } from '../common/events';
import Cdp from './api';
import { IRawTelemetryReporter, TelemetryReporter } from '../telemetry/telemetryReporter';
import { HighResolutionTime } from '../utils/performance';
import { logger } from '../common/logging/logger';
import { LogTag } from '../common/logging';

interface IProtocolCommand {
  id?: number;
  method: string;
  params: object;
  sessionId?: string;
}

interface IProtocolError {
  id: number;
  method?: string;
  error: { code: number; message: string };
  sessionId?: string;
}

interface IProtocolSuccess {
  id: number;
  result: object;
  sessionId?: string;
}

type ProtocolMessage = IProtocolCommand | IProtocolSuccess | IProtocolError;

interface IProtocolCallback {
  resolve: (o: object) => void;
  reject: (e: Error) => void;
  from: Error;
  method: string;
}

let connectionId = 0;

export default class Connection {
  private _connectionId = connectionId++;
  private _lastId: number;
  private _transport: ITransport;
  private _sessions: Map<string, CDPSession>;
  private _closed: boolean;
  private _rootSession: CDPSession;
  private _onDisconnectedEmitter = new EventEmitter<void>();
  readonly onDisconnected = this._onDisconnectedEmitter.event;
  private readonly _telemetryReporter: TelemetryReporter;

  constructor(transport: ITransport, rawTelemetryReporter: IRawTelemetryReporter) {
    this._lastId = 0;
    this._transport = transport;
    this._transport.onmessage = this._onMessage.bind(this);
    this._transport.onend = this._onTransportClose.bind(this);
    this._sessions = new Map();
    this._closed = false;
    this._rootSession = new CDPSession(this, '');
    this._sessions.set('', this._rootSession);
    this._telemetryReporter = TelemetryReporter.cdp(rawTelemetryReporter);
  }

  rootSession(): Cdp.Api {
    return this._rootSession.cdp();
  }

  _send(method: string, params: object | undefined = {}, sessionId: string): number {
    const id = ++this._lastId;
    const message: IProtocolCommand = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    const messageString = JSON.stringify(message);
    logger.verbose(LogTag.CdpSend, undefined, { connectionId: this._connectionId, message });
    this._transport.send(messageString);
    return id;
  }

  async _onMessage(message: string, receivedTime: HighResolutionTime) {
    const object = JSON.parse(message);
    logger.verbose(LogTag.CdpReceive, undefined, {
      connectionId: this._connectionId,
      message: object,
    });

    const session = this._sessions.get(object.sessionId || '');
    if (session) {
      const eventName = object.method;
      try {
        session._onMessage(object);
        if (eventName) this._telemetryReporter.reportSuccess(eventName, receivedTime);
      } catch (error) {
        if (eventName) this._telemetryReporter.reportError(eventName, receivedTime, error);
      }
    } else {
      throw new Error(`Unknown session id: ${object.sessionId}`);
    }
  }

  _onTransportClose() {
    if (this._closed) return;
    this._closed = true;
    this._transport.onmessage = undefined;
    this._transport.onend = undefined;
    for (const session of this._sessions.values()) session._onClose();
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
    if (!session) return;
    session._onClose();
    this._sessions.delete(session.sessionId());
  }
}

// Node versions before 12 do not guarantee relative order of tasks and microstasks.
// We artificially queue protocol messages to achieve this.
const needsReordering = +process.version.substring(1).split('.')[0] <= 12;

class CDPSession {
  private _connection?: Connection;
  private _callbacks: Map<number, IProtocolCallback>;
  private _sessionId: string;
  private _cdp: Cdp.Api;
  private _queue: ProtocolMessage[] = [];
  private _listeners = new Map<string, Set<(params: object) => void>>();
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
    logger.verbose(LogTag.CdpReceive, 'Dequeue messages', { message: toSend });
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
    return new Proxy(
      {},
      {
        get: (_target, agentName: string) => {
          if (agentName === 'pause') return () => this.pause();
          if (agentName === 'resume') return () => this.resume();

          return new Proxy(
            {},
            {
              get: (_target, methodName: string) => {
                if (methodName === 'then') return;
                if (methodName === 'on')
                  return (eventName: string, listener: (params: object) => void) =>
                    this._on(`${agentName}.${eventName}`, listener);
                if (methodName === 'off')
                  return (eventName: string, listener: (params: object) => void) =>
                    this._off(`${agentName}.${eventName}`, listener);
                return (params: object | undefined) =>
                  this._send(`${agentName}.${methodName}`, params);
              },
            },
          );
        },
      },
    ) as Cdp.Api;
  }

  _on(method: string, listener: (params: object) => void): void {
    let listenerSet = this._listeners.get(method);
    if (!listenerSet) {
      listenerSet = new Set();
      this._listeners.set(method, listenerSet);
    }

    listenerSet.add(listener);
  }

  _off(method: string, listener: (params: object) => void): void {
    const listeners = this._listeners.get(method);
    if (listeners) listeners.delete(listener);
  }

  _send(method: string, params: object | undefined = {}): Promise<object | undefined> {
    return this._sendOrDie(method, params).catch(() => undefined);
  }

  _sendOrDie(method: string, params: object | undefined = {}): Promise<object | undefined> {
    if (!this._connection)
      return Promise.reject(
        new Error(
          `Protocol error (${method}): Session closed. Most likely the target has been closed.`,
        ),
      );
    const id = this._connection._send(method, params, this._sessionId);
    return new Promise((resolve, reject) => {
      this._callbacks.set(id, { resolve, reject, from: new Error(), method });
    });
  }

  _onMessage(object: ProtocolMessage) {
    // If we're paused, queue events but still process responses to avoid hanging.
    if (this.paused && object.id) {
      this._processResponse(object);
      return;
    }

    // either replaying a paused queue, or needs reordering, if there's a queue
    if (this._queue.length > 0) {
      this._queue.push(object);
      return;
    }

    // otherwise, if we don't need reordering and aren't paused, process it now
    if (!needsReordering && !this.paused) {
      this._processResponse(object);
      return;
    }

    // we know now that we have no existing queue but need to queue an item. Do so.
    this._queue.push(object);
    if (!this.paused) {
      this._processQueue();
    }
  }

  _processQueue() {
    setTimeout(() => {
      if (this.paused) {
        return;
      }

      const object = this._queue.shift();
      if (!object) {
        return;
      }

      this._processResponse(object);
      if (this._queue.length) {
        this._processQueue();
      }
    }, 0);
  }

  _processResponse(object: ProtocolMessage) {
    if (object.id === undefined) {
      // for some reason, TS doesn't narrow this even though IProtocolCommand
      // is the only type of the tuple where id can be undefined.
      const asCommand = object as IProtocolCommand;
      const listeners = this._listeners.get(asCommand.method);
      for (const listener of listeners || []) {
        listener(asCommand.params);
      }

      return;
    }

    const callback = this._callbacks.get(object.id);
    if (!callback) {
      return;
    }

    this._callbacks.delete(object.id);
    if ('error' in object) {
      callback.from.message = `Protocol error (${object.method}): ${object.error.message}`;
      callback.from.message += ` - ${JSON.stringify(object.error)}`;
      callback.reject(callback.from);
    } else if ('result' in object) {
      callback.resolve(object.result);
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
