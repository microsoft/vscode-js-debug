import { EventEmitter } from 'events';
import { Transport } from './transport';
import * as debug from 'debug';
import { Protocol } from 'devtools-protocol';

const debugProtocol = debug('protocol');

interface Callback {
	resolve: (o: object) => void;
	reject: (e: Error) => void;
	from: Error;
	method: string;
}

export const ConnectionEvents = {
	Disconnected: Symbol('Disconnected')
}

export class Connection extends EventEmitter {
	private _url: string;
	private _lastId: number;
	private _callbacks: Map<number, Callback>;
	private _transport: any;
	private _sessions: Map<string, CDPSession>;
	private _closed: boolean;

  constructor(url: string, transport: Transport) {
    super();
    this._url = url;
    this._lastId = 0;
    this._callbacks = new Map();

    this._transport = transport;
    this._transport.onmessage = this._onMessage.bind(this);
    this._transport.onclose = this._onClose.bind(this);
    this._sessions = new Map();
    this._closed = false;
  }

  static fromSession(session: CDPSession): Connection {
    return session._connection;
  }

  session(sessionId: string): CDPSession | null {
    return this._sessions.get(sessionId) || null;
  }

  url(): string {
    return this._url;
  }

  send(method: string, params: object | undefined = {}): Promise<object | null> {
    const id = this._rawSend({method, params});
    return new Promise((resolve, reject) => {
      this._callbacks.set(id, {resolve, reject, from: new Error(), method});
    });
  }

  _rawSend(message: Object): number {
    const id = ++this._lastId;
    const messageString = JSON.stringify(Object.assign({}, message, {id}));
    debugProtocol('SEND ► ' + messageString);
    this._transport.send(messageString);
    return id;
  }

  async _onMessage(message: string) {
    debugProtocol('◀ RECV ' + message);
    const object = JSON.parse(message);
    if (object.method === 'Target.attachedToTarget') {
      const sessionId = object.params.sessionId;
      const session = new CDPSession(this, object.params.targetInfo.type, sessionId);
      this._sessions.set(sessionId, session);
    } else if (object.method === 'Target.detachedFromTarget') {
      const session = this._sessions.get(object.params.sessionId);
      if (session) {
        session._onClosed();
        this._sessions.delete(object.params.sessionId);
      }
    }
    if (object.sessionId) {
      const session = this._sessions.get(object.sessionId);
      if (session)
        session._onMessage(object);
    } else if (object.id) {
      const callback = this._callbacks.get(object.id);
      // Callbacks could be all rejected if someone has called `.dispose()`.
      if (callback) {
        this._callbacks.delete(object.id);
        if (object.error)
          callback.reject(createProtocolError(callback.from, callback.method, object.error));
        else
          callback.resolve(object.result);
      }
    } else {
      this.emit(object.method, object.params);
    }
  }

  _onClose() {
    if (this._closed)
      return;
    this._closed = true;
    this._transport.onmessage = null;
    this._transport.onclose = null;
    for (const callback of this._callbacks.values())
      callback.reject(rewriteError(callback.from, `Protocol error (${callback.method}): Target closed.`));
    this._callbacks.clear();
    for (const session of this._sessions.values())
      session._onClosed();
    this._sessions.clear();
    this.emit(ConnectionEvents.Disconnected);
  }

  dispose() {
    this._onClose();
    this._transport.close();
  }

  /**
   * @param {Protocol.Target.TargetInfo} targetInfo
   * @return {!Promise<!CDPSession>}
   */
  async createSession(targetInfo: Protocol.Target.TargetInfo): Promise<CDPSession> {
    const {sessionId} = await this.send('Target.attachToTarget', {targetId: targetInfo.targetId, flatten: true}) as {sessionId:string};
    return this._sessions.get(sessionId);
  }
}

export class CDPSession extends EventEmitter {
	_connection: Connection;
	_callbacks: Map<number, Callback>;
	_targetType: string;
	_sessionId: string;

	constructor(connection: Connection, targetType: string, sessionId: string) {
    super();
    this._callbacks = new Map();
    this._connection = connection;
    this._targetType = targetType;
    this._sessionId = sessionId;
  }

  send(method: string, params: object | undefined = {}): Promise<object | null> {
    if (!this._connection)
      return Promise.reject(new Error(`Protocol error (${method}): Session closed. Most likely the ${this._targetType} has been closed.`));
    const id = this._connection._rawSend({sessionId: this._sessionId, method, params});
    return new Promise((resolve, reject) => {
      this._callbacks.set(id, {resolve, reject, from: new Error(), method});
    });
  }

  _onMessage(object: { id?: number; method: string; params: object; error: { message: string; data: any; }; result?: any; }) {
    if (object.id && this._callbacks.has(object.id)) {
      const callback = this._callbacks.get(object.id);
      this._callbacks.delete(object.id);
      if (object.error)
        callback.reject(createProtocolError(callback.from, callback.method, object.error));
      else
        callback.resolve(object.result);
    } else {
			if(object.id)
			  throw new Error();
      this.emit(object.method, object.params);
    }
  }

  async detach() {
    if (!this._connection)
      throw new Error(`Session already detached. Most likely the ${this._targetType} has been closed.`);
    await this._connection.send('Target.detachFromTarget',  {sessionId: this._sessionId});
  }

  _onClosed() {
    for (const callback of this._callbacks.values())
      callback.reject(rewriteError(callback.from, `Protocol error (${callback.method}): Target closed.`));
    this._callbacks.clear();
    this._connection = null;
    this.emit(ConnectionEvents.Disconnected);
  }
}

interface ProtocolError {
	message: string;
	data: any;
}

function createProtocolError(error: Error, method: string, errorObject: ProtocolError): Error {
  let message = `Protocol error (${method}): ${errorObject.message}`;
  if ('data' in errorObject)
    message += ` ${errorObject.data}`;
  return rewriteError(error, message);
}

function rewriteError(error: Error, message: string): Error {
  error.message = message;
  return error;
}
