import { EventEmitter } from 'events';
import { Transport } from './transport';
import * as debug from 'debug';
import Protocol from 'devtools-protocol';
import ProtocolProxyApi from 'devtools-protocol/types/protocol-proxy-api';

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

export const SessionEvents = {
  Disconnected: Symbol('Disconnected')
}

export class Connection extends EventEmitter {
  private _lastId: number;
  private _transport: any;
  private _sessions: Map<string, CDPSession>;
  private _closed: boolean;
  private _browserSession: CDPSession;

  constructor(transport: Transport) {
    super();
    this._lastId = 0;
    this._transport = transport;
    this._transport.onmessage = this._onMessage.bind(this);
    this._transport.onclose = this._onTransportClose.bind(this);
    this._sessions = new Map();
    this._closed = false;
    this._browserSession = new CDPSession(this, '');
    this._sessions.set('', this._browserSession);
  }

  browserSession(): CDPSession {
    return this._browserSession;
  }

  session(sessionId: string): CDPSession {
    return this._sessions.get(sessionId);
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
    this._transport.onmessage = null;
    this._transport.onclose = null;
    for (const session of this._sessions.values())
      session._onClose();
    this._sessions.clear();
  }

  dispose() {
    this._onTransportClose();
    this._transport.close();
  }

  createSession(sessionId: Protocol.Target.SessionID): CDPSession {
    const session = new CDPSession(this, sessionId);
    this._sessions.set(sessionId, session);
    return session;
  }

  _disposeSession(session: CDPSession) {
    session._onClose();
    this._sessions.delete(session.sessionId());
  }
}

export class CDPSession extends EventEmitter {
  private _connection: Connection;
  private _callbacks: Map<number, ProtocolCallback>;
  private _sessionId: string;
  private _cdp: ProtocolProxyApi.ProtocolApi;

  constructor(connection: Connection, sessionId: string) {
    super();
    this._callbacks = new Map();
    this._connection = connection;
    this._sessionId = sessionId;
    this._cdp = this._createApi();
  }

  cdp(): ProtocolProxyApi.ProtocolApi {
    return this._cdp;
  }

  sessionId(): Protocol.Target.SessionID {
    return this._sessionId;
  }

  _createApi(): ProtocolProxyApi.ProtocolApi {
    return new Proxy({}, {
      get: (target, agentName: string, receiver) => new Proxy({}, {
        get: (target, methodName: string, receiver) => {
          if (methodName === 'on')
            return (eventName, listener) => this.on(`${agentName}.${eventName}`, listener);
          if (methodName === 'once')
            return (eventName, listener) => this.once(`${agentName}.${eventName}`, listener);
          if (methodName === 'off')
            return (eventName, listener) => this.removeListener(`${agentName}.${eventName}`, listener);
          return params => this.send(`${agentName}.${methodName}`, params);
        }
      })
    }) as ProtocolProxyApi.ProtocolApi;
  }

  send(method: string, params: object | undefined = {}): Promise<object | null> {
    return this.sendOrDie(method, params).catch(e => {
      console.error(e);
      return null;
    });
  }

  sendOrDie(method: string, params: object | undefined = {}): Promise<object | null> {
    if (!this._connection)
      return Promise.reject(new Error(`Protocol error (${method}): Session closed. Most likely the target has been closed.`));
    const id = this._connection._send(method, params, this._sessionId);
    return new Promise((resolve, reject) => {
      this._callbacks.set(id, { resolve, reject, from: new Error(), method });
    });
  }

  _onMessage(object: ProtocolResponse) {
    if (object.id && this._callbacks.has(object.id)) {
      const callback = this._callbacks.get(object.id);
      this._callbacks.delete(object.id);
      if (object.error) {
        callback.from.message = `Protocol error (${object.method}): ${object.error.message}`;
        if (object.error)
          callback.from.message += ` - ${JSON.stringify(object.error)}`;
        callback.reject(callback.from);
      } else {
        callback.resolve(object.result);
      }
    } else {
      if (object.id)
        throw new Error();
      this.emit(object.method, object.params);
    }
  }

  dispose() {
    if (this._connection)
      this._connection._disposeSession(this);
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
    this._connection = null;
    this.emit(SessionEvents.Disconnected);
  }
}
