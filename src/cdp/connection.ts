/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { IDisposable } from '../common/disposable';
import { EventEmitter, ListenerMap } from '../common/events';
import { HrTime } from '../common/hrnow';
import { ILogger, LogTag } from '../common/logging';
import { isDataUri } from '../common/urlUtils';
import { ITelemetryReporter } from '../telemetry/telemetryReporter';
import Cdp from './api';
import { CdpProtocol } from './protocol';
import { ITransport } from './transport';

interface IProtocolCallback {
  resolve: (o: object) => void;
  reject: (e: Error) => void;
  from: ProtocolError;
  method: string;
}

let connectionId = 0;

export const ICdpApi = Symbol('ICdpApi');

export class ProtocolError extends Error {
  public cause?: { code: number; message: string };

  constructor(public readonly method: string) {
    super('<<message>>');
  }

  public setCause(code: number, message: string) {
    this.cause = { code, message };
    this.message = `CDP error ${code} calling method ${this.method}: ${message}`;
    this.stack = this.stack?.replace('<<message>>', this.message);
    return this;
  }
}

export default class Connection {
  private _connectionId = connectionId++;
  private _lastId = 1000;
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

  public _send(method: string, params: object | undefined = {}, sessionId: string): number {
    const id = ++this._lastId;
    const message: CdpProtocol.ICommand = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    const messageString = JSON.stringify(message);
    this.logger.verbose(LogTag.CdpSend, undefined, { connectionId: this._connectionId, message });
    this._transport.send(messageString);
    return id;
  }

  private _onMessage(message: string, receivedTime: HrTime) {
    const object = JSON.parse(message);
    let objectToLog = object;

    // Don't print source code of getScriptSource responses
    if (object.result && object.result.scriptSource) {
      objectToLog = { ...object, result: { ...object.result, scriptSource: '<script source>' } };
    } else if (
      object.method === 'Debugger.scriptParsed'
      && object.params
      && isDataUri(object.params.sourceMapURL)
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

  private _onTransportClose() {
    if (this._closed) return;
    this._closed = true;
    this._transport.dispose();
    this.logger.info(LogTag.CdpReceive, 'Connection closed', {
      connectionId: this._connectionId,
    });
    for (const session of this._sessions.values()) session._onClose();
    this._sessions.clear();
    this._onDisconnectedEmitter.fire();
  }

  public close() {
    this._onTransportClose();
  }

  public isClosed(): boolean {
    return this._closed;
  }

  public createSession(sessionId: Cdp.Target.SessionID): Cdp.Api {
    const session = new CDPSession(this, sessionId, this.logger);
    this._sessions.set(sessionId, session);
    return session.cdp();
  }

  public disposeSession(sessionId: Cdp.Target.SessionID) {
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

export class CDPSession {
  private _connection?: Connection;
  private _callbacks: Map<number, IProtocolCallback>;
  private _sessionId: string;
  private _cdp: Cdp.Api;
  private _queue: CdpProtocol.Message[] = [];
  private _prefixListeners = new ListenerMap<string, CdpProtocol.ICommand>();
  private _directListeners = new ListenerMap<string, object>();
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
          if (agentName === 'session') return this;

          return new Proxy(
            {},
            {
              get: (_target, methodName: string) => {
                if (methodName === 'then') return;
                if (methodName === 'on') {
                  return (eventName: string, listener: (params: object) => void) =>
                    this.on(`${agentName}.${eventName}`, listener);
                }
                return (params: object | undefined) =>
                  this.send(`${agentName}.${methodName}`, params);
              },
            },
          );
        },
      },
    ) as Cdp.Api;
  }

  /**
   * Adds a new listener for the given method.
   */
  public on(method: string, listener: (params: object) => void): IDisposable {
    return this._directListeners.listen(method, listener);
  }

  /**
   * Adds a new listener for the given prefix.
   */
  public onPrefix(method: string, listener: (params: CdpProtocol.ICommand) => void): IDisposable {
    return this._prefixListeners.listen(method, listener);
  }

  /**
   * Sends a request to CDP, returning its untyped result.
   */
  public send(method: string, params: object | undefined = {}): Promise<object | undefined> {
    return this.sendOrDie(method, params).catch(() => undefined);
  }

  /**
   * Sends a request to CDP, returning a standard Promise
   * with its resulting state.
   */
  public sendOrDie(method: string, params: object | undefined = {}): Promise<object> {
    if (!this._connection) {
      return Promise.reject(new ProtocolError(method).setCause(0, 'Connection is closed'));
    }

    const id = this._connection._send(method, params, this._sessionId);
    return new Promise<object>((resolve, reject) => {
      this._callbacks.set(id, {
        resolve,
        reject,
        from: new ProtocolError(method),
        method,
      });
    });
  }

  /**
   * Handles an incoming message. Called by the connection.
   */
  public _onMessage(object: CdpProtocol.Message) {
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

  private _processQueue() {
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

  private _processResponse(object: CdpProtocol.Message) {
    if (object.id === undefined) {
      // for some reason, TS doesn't narrow this even though CdpProtocol.ICommand
      // is the only type of the tuple where id can be undefined.
      const asCommand = object as CdpProtocol.ICommand;
      this._directListeners.emit(asCommand.method, asCommand.params);

      // May eventually be useful to use a trie here if
      // this becomes hot with many listeners
      for (const [key, emitter] of this._prefixListeners.listeners) {
        if (asCommand.method.startsWith(key)) {
          emitter.fire(asCommand);
        }
      }

      return;
    }

    const callback = this._callbacks.get(object.id);
    if (!callback) {
      return;
    }

    this._callbacks.delete(object.id);
    if ('error' in object) {
      callback.reject(callback.from.setCause(object.error.code, object.error.message));
    } else if ('result' in object) {
      callback.resolve(object.result);
    }
  }

  public async detach() {
    if (!this._connection) {
      throw new Error(`Session already detached. Most likely the target has been closed.`);
    }

    this._connection._send('Target.detachFromTarget', {}, this._sessionId);
  }

  public isClosed(): boolean {
    return !this._connection;
  }

  /**
   * Marks the session as closed, called by the connection.
   */
  _onClose() {
    for (const callback of this._callbacks.values()) {
      callback.reject(callback.from.setCause(0, 'Connection is closed'));
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
