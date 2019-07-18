// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Transport } from './transport';
import * as debug from 'debug';
import * as vscode from 'vscode';
import { EventEmitter } from 'events';
import Cdp from './api';

const debugConnection = debug('connection');

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
  private _browserSession: CDPSession;
  private _onDisconnectedEmitter = new vscode.EventEmitter();
  readonly onDisconnected = this._onDisconnectedEmitter.event;

  constructor(transport: Transport) {
    this._lastId = 0;
    this._transport = transport;
    this._transport.onmessage = this._onMessage.bind(this);
    this._transport.onclose = this._onTransportClose.bind(this);
    this._sessions = new Map();
    this._closed = false;
    this._browserSession = new CDPSession(this, '');
    this._sessions.set('', this._browserSession);
  }

  browser(): Cdp.Api {
    return this._browserSession.cdp();
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
    debugConnection('SEND ► ' + messageString);
    this._transport.send(messageString);
    return id;
  }

  async _onMessage(message: string) {
    debugConnection('◀ RECV ' + message);
    const object = JSON.parse(message);

    const session = this._sessions.get(object.sessionId || '');
    if (session)
      session._onMessage(object);
    else
      throw new Error(`Unknown session id: ${object.sessionId}`)
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

  async clone(): Promise<Connection> {
    return new Connection(await this._transport.clone());
  }
}

class CDPSession extends EventEmitter {
  private _connection?: Connection;
  private _callbacks: Map<number, ProtocolCallback>;
  private _sessionId: string;
  private _cdp: Cdp.Api;
  private _queue?: ProtocolResponse[];

  constructor(connection: Connection, sessionId: string) {
    super();
    this._callbacks = new Map();
    this._connection = connection;
    this._sessionId = sessionId;
    this._cdp = this._createApi();

    const nodeVersion = +process.version.substring(1).split('.')[0];
    if (nodeVersion < 11) {
      // Node versions before 11 do not guarantee relative order of tasks and microstasks.
      // We artificially queue protocol messages to achieve this.
      this._queue = [];
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
      get: (target, agentName: string, receiver) => new Proxy({}, {
        get: (target, methodName: string, receiver) => {
          if (methodName === 'on')
            return (eventName, listener) => this.on(`${agentName}.${eventName}`, listener);
          if (methodName === 'once')
            return (eventName, listener) => this.once(`${agentName}.${eventName}`, listener);
          if (methodName === 'off')
            return (eventName, listener) => this.removeListener(`${agentName}.${eventName}`, listener);
          return params => this._send(`${agentName}.${methodName}`, params);
        }
      })
    }) as Cdp.Api;
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
    if (!this._queue) {
      this._processResponse(object);
      return;
    }
    this._queue.push(object);
    if (this._queue.length === 1)
      this._processQueue();
  }

  _processQueue() {
    setTimeout(() => {
      const object = this._queue!.shift()!;
      this._processResponse(object);
      if (this._queue!.length)
        this._processQueue();
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
      if (object.id)
        throw new Error();
      this.emit(object.method!, object.params);
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
