/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { ITransport } from './transport';
import { EventEmitter } from '../common/events';
import Cdp from './api';
import { ITelemetryReporter } from '../telemetry/telemetryReporter';
import { LogTag, ILogger } from '../common/logging';
import { IDisposable } from '../common/disposable';
import { HrTime } from '../common/hrnow';

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

export const ICdpApi = Symbol('ICdpApi');

export default class Connection {
  private _connectionId = connectionId++;
  private _lastId: number;
  private _transport: ITransport;
  private _sessions: Map<string, CDPSession>;
  private _disposedSessions = new Map<string, Date>();
  private _closed: boolean;
  private _rootSession: CDPSession;
  private _onDisconnectedEmitter = new EventEmitter<void>();
  public readonly waitWrapper = makeWaitForNextTask();
  readonly onDisconnected = this._onDisconnectedEmitter.event;

  constructor(
    transport: ITransport,
    private readonly logger: ILogger,
    private readonly telemetryReporter: ITelemetryReporter,
  ) {
    this._lastId = 0;
    this._transport = transport;
    this._transport.onMessage(([message, time]) => this._onMessage(message, time));
    this._transport.onEnd(() => this._onTransportClose());
    this._sessions = new Map();
    this._closed = false;
    this._rootSession = new CDPSession(this, '', this.logger);
    this._sessions.set('', this._rootSession);
  }

  rootSession(): Cdp.Api {
    return this._rootSession.cdp();
  }

  _send(method: string, params: object | undefined = {}, sessionId: string): number {
    const id = ++this._lastId;
    const message: IProtocolCommand = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    const messageString = JSON.stringify(message);
    this.logger.verbose(LogTag.CdpSend, undefined, { connectionId: this._connectionId, message });
    this._transport.send(messageString);
    return id;
  }

  async _onMessage(message: string, receivedTime: HrTime) {
    const object = JSON.parse(message);
    let objectToLog = object;

    // Don't print source code of getScriptSource responses
    if (object.result && object.result.scriptSource) {
      objectToLog = { ...object, result: { ...object.result, scriptSource: '<script source>' } };
    } else if (
      object.method === 'Debugger.scriptParsed' &&
      object.params &&
      object.params.sourceMapURL &&
      object.params.sourceMapURL.startsWith('data:')
    ) {
      objectToLog = {
        ...object,
        params: { ...object.params, sourceMapURL: '<data source map url>' },
      };
    }

    this.logger.verbose(LogTag.CdpReceive, undefined, {
      connectionId: this._connectionId,
      message: objectToLog,
    });

    const session = this._sessions.get(object.sessionId || '');
    if (!session) {
      const disposedDate = this._disposedSessions.get(object.sessionId);
      if (!disposedDate) {
        throw new Error(
          `Unknown session id: ${object.sessionId} while processing: ${object.method}`,
        );
      } else {
        const secondsAgo = (Date.now() - disposedDate.getTime()) / 1000.0;
        this.logger.warn(
          LogTag.Internal,
          `Got message for a session disposed ${secondsAgo} seconds ago`,
          { sessionId: object.sessionId, disposeOn: disposedDate },
        );
        return; // We just ignore messages for disposed sessions
      }
    }

    const eventName = object.method;
    let error: Error | undefined;
    try {
      session._onMessage(object);
    } catch (e) {
      error = e;
    }

    // if eventName is undefined is because this is a response to a cdp request, so we don't report it
    if (eventName) {
      this.telemetryReporter.reportOperation(
        'cdpOperation',
        eventName,
        receivedTime.elapsed().ms,
        error,
      );
    }
  }

  _onTransportClose() {
    if (this._closed) return;
    this._closed = true;
    this._transport.dispose();
    for (const session of this._sessions.values()) session._onClose();
    this._sessions.clear();
    this._onDisconnectedEmitter.fire();
  }

  close() {
    this._onTransportClose();
  }

  isClosed(): boolean {
    return this._closed;
  }

  createSession(sessionId: Cdp.Target.SessionID): Cdp.Api {
    const session = new CDPSession(this, sessionId, this.logger);
    this._sessions.set(sessionId, session);
    return session.cdp();
  }

  disposeSession(sessionId: Cdp.Target.SessionID) {
    const session = this._sessions.get(sessionId);
    if (!session) return;
    session._onClose();
    this._disposedSessions.set(session.sessionId(), new Date());
    this._sessions.delete(session.sessionId());
  }
}

// Node versions before 11.0.0 do not guarantee relative order of tasks and microstasks.
// We artificially queue protocol messages to achieve this.
const needsReordering = +process.version.substring(1).split('.')[0] < 11;

class CDPSession {
  private _connection?: Connection;
  private _callbacks: Map<number, IProtocolCallback>;
  private _sessionId: string;
  private _cdp: Cdp.Api;
  private _queue: ProtocolMessage[] = [];
  private _listeners = new Map<string, Set<(params: object) => void>>();
  private paused = false;

  constructor(connection: Connection, sessionId: string, private readonly logger: ILogger) {
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
    this.logger.verbose(LogTag.CdpReceive, 'Dequeue messages', { message: toSend });
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

  _on(method: string, listener: (params: object) => void): IDisposable {
    let listenerSet = this._listeners.get(method);
    if (!listenerSet) {
      listenerSet = new Set();
      this._listeners.set(method, listenerSet);
    }

    listenerSet.add(listener);
    return { dispose: () => this._off(method, listener) };
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
    this._connection?.waitWrapper(() => {
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
    });
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

// implementation taken from playwright: https://github.com/microsoft/playwright/blob/59d0f8728d4809b39785d68d7a146f06f0dbe2e6/src/helper.ts#L233
// See https://joel.tools/microtasks/
function makeWaitForNextTask() {
  if (parseInt(process.versions.node, 10) >= 11) return setImmediate;

  // Unlike Node 11, Node 10 and less have a bug with Task and MicroTask execution order:
  // - https://github.com/nodejs/node/issues/22257
  //
  // So we can't simply run setImmediate to dispatch code in a following task.
  // However, we can run setImmediate from-inside setImmediate to make sure we're getting
  // in the following task.

  let spinning = false;
  const callbacks: (() => void)[] = [];
  const loop = () => {
    const callback = callbacks.shift();
    if (!callback) {
      spinning = false;
      return;
    }
    setImmediate(loop);
    // Make sure to call callback() as the last thing since it's
    // untrusted code that might throw.
    callback();
  };

  return (callback: () => void) => {
    callbacks.push(callback);
    if (!spinning) {
      spinning = true;
      setImmediate(loop);
    }
  };
}
