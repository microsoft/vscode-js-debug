// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import Dap from './api';

import { HighResolutionTime } from '../utils/performance';
import { TelemetryReporter } from '../telemetry/telemetryReporter';

export interface Message {
  sessionId?: string;
  seq: number;
  type: string;
  command?: string;
  event?: string;
  body?: any;
  arguments?: any;
  request_seq?: number;
  success?: boolean;
  message?: string;
  __receivedTime?: HighResolutionTime;
}

export default class Connection {
  private static _TWO_CRLF = '\r\n\r\n';

  private _writableStream?: NodeJS.WritableStream;
  private _rawData: Buffer;
  private _contentLength = -1;
  private _sequence: number;

  private _pendingRequests = new Map<number, (result: string | object) => void>();
  private _requestHandlers = new Map<string, (params: any) => Promise<any>>();
  private _eventListeners = new Map<string, Set<(params: any) => any>>();
  private _dap: Promise<Dap.Api>;

  protected _ready: (dap: Dap.Api) => void;
  private _logPath?: string;
  private _logPrefix = '';
  private _telemetryReporter: TelemetryReporter | undefined;

  constructor() {
    this._sequence = 1;
    this._rawData = new Buffer(0);
    this._ready = () => {};
    this._dap = new Promise<Dap.Api>(f => this._ready = f);
  }

  public init(inStream: NodeJS.ReadableStream, outStream: NodeJS.WritableStream) {
    this._writableStream = outStream;
    inStream.on('data', (data: Buffer) => {
      this._handleData(data);
    });
    inStream.on('close', () => {
    });
    inStream.on('error', (error) => {
      // error.message
    });
    outStream.on('error', (error) => {
      // error.message
    });
    inStream.resume();
    const dap = this._createApi();
    this._ready(dap);
    this._telemetryReporter = TelemetryReporter.dap(dap);
  }

  public dap(): Promise<Dap.Api> {
    return this._dap;
  }

  public setLogConfig(prefix: string, path?: string) {
    this._logPrefix = prefix;
    this._logPath = path;
  }

  _createApi(): Dap.Api {
    const requestSuffix = 'Request';

    return new Proxy({}, {
      get: (target, methodName: string, receiver) => {
        if (methodName === 'then')
          return;
        if (methodName === 'on') {
          return (requestName: string, handler: (params: any) => Promise<any>) => {
            this._requestHandlers.set(requestName, handler);
            return () => this._requestHandlers.delete(requestName);
          }
        }
        if (methodName === 'off')
          return (requestName: string, handler: () => void) => this._requestHandlers.delete(requestName);
        return (params?: object) => {
          if (methodName.endsWith(requestSuffix)) {
            return this.enqueueRequest(methodName.slice(0, -requestSuffix.length), params);
          }

          this._send({ seq: 0, type: 'event', event: methodName, body: params });
        };
      }
    }) as Dap.Api;
  }

  createTestApi(): Dap.TestApi {
    const on = (eventName: string, listener: () => void) => {
      let listeners = this._eventListeners.get(eventName);
      if (!listeners) {
        listeners = new Set();
        this._eventListeners.set(eventName, listeners);
      }
      listeners.add(listener);
    };
    const off = (eventName: string, listener: () => void) => {
      const listeners = this._eventListeners.get(eventName);
      if (listeners)
        listeners.delete(listener);
    };
    const once = (eventName: string, filter: (params?: object) => boolean) => {
      return new Promise(cb => {
        const listener = (params?: object) => {
          if (filter && !filter(params))
            return;
          off(eventName, listener);
          cb(params);
        };
        on(eventName, listener);
      });
    };
    return new Proxy({}, {
      get: (_target, methodName: string, _receiver) => {
        if (methodName === 'on')
          return on;
        if (methodName === 'off')
          return off;
        if (methodName === 'once')
          return once;
        return (params?: object) => this.enqueueRequest(methodName, params);
      }
    }) as Dap.TestApi;
  }

  private enqueueRequest(command: string, params?: object) {
    return new Promise(cb => {
      const request: Message = { seq: 0, type: 'request', command };
      if (params && Object.keys(params).length > 0)
        request.arguments = params;
      this._pendingRequests.set(this._sequence, cb);
      this._send(request);
    });
  }

  public stop(): void {
    if (this._writableStream) {
      this._writableStream.end();
      this._writableStream = undefined;
    }
  }

  _send(message: Message) {
    message.seq = this._sequence++;
    const json = JSON.stringify(message);
    if (this._logPath)
      require('fs').appendFileSync(this._logPath, `◀ SEND [${this._logPrefix}] ${json}\n`);
    const data = `Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`;
    if (!this._writableStream) {
      console.error('Writing to a closed connection');
      return;
    }
    this._writableStream.write(data, 'utf8');
  }

  async _onMessage(msg: Message, receivedTime: HighResolutionTime): Promise<void> {
    if (msg.type === 'request') {
      const response: Message = { seq: 0, type: 'response', request_seq: msg.seq, command: msg.command, success: true };
      try {
        const callback = this._requestHandlers.get(msg.command!);
        if (!callback) {
          response.success = false;
          response.body = {
            error: {
              id: 9221,
              format: `Unrecognized request: ${msg.command}`,
              showUser: false,
              sendTelemetry: false
            }
          };
          console.error(`Unknown request: ${msg.command}`);
          // this._send(response);
        } else {
          const result = await callback(msg.arguments!);
          if (result.__errorMarker) {
            response.success = false;
            response.message = result.error.format;
            response.body = { error: result.error };
          } else {
            response.body = result;
          }
          this._send(response);
        }
        this._telemetryReporter!.reportSucces(msg.command!, receivedTime);
      } catch (e) {
        console.error(e);
        response.success = false;
        response.body = {
          error: {
            id: 9221,
            format: `Error processing ${msg.command}: ${e.stack || e.message}`,
            showUser: false,
            sendTelemetry: false
          }
        };
        this._send(response);
        this._telemetryReporter!.reportError(msg.command!, receivedTime, e);
      }
    }
    if (msg.type === 'event') {
      const listeners = this._eventListeners.get(msg.event!) || new Set();
      for (const listener of listeners)
        listener(msg.body);
    }
    if (msg.type === 'response') {
      const cb = this._pendingRequests.get(msg.request_seq!)!;
      this._pendingRequests.delete(msg.request_seq!);
      if (msg.success) {
        cb(msg.body as object);
      } else {
        const format: string | undefined = msg.body && msg.body.error && msg.body.error.format;
        cb(format || msg.message || `Unknown error`);
      }
    }
  }

  _handleData(data: Buffer): void {
    const receivedTime = process.hrtime();
    this._rawData = Buffer.concat([this._rawData, data]);
    while (true) {
      if (this._contentLength >= 0) {
        if (this._rawData.length >= this._contentLength) {
          const message = this._rawData.toString('utf8', 0, this._contentLength);
          this._rawData = this._rawData.slice(this._contentLength);
          this._contentLength = -1;
          if (message.length > 0) {
            try {
              if (this._logPath)
                require('fs').appendFileSync(this._logPath, `RECV ► [${this._logPrefix}] ${message}\n`);
              let msg: Message = JSON.parse(message);
              this._onMessage(msg, receivedTime);
            }
            catch (e) {
              console.error('Error handling data: ' + (e && e.message));
            }
          }
          continue;	// there may be more complete messages to process
        }
      } else {
        const idx = this._rawData.indexOf(Connection._TWO_CRLF);
        if (idx !== -1) {
          const header = this._rawData.toString('utf8', 0, idx);
          const lines = header.split('\r\n');
          for (let i = 0; i < lines.length; i++) {
            const pair = lines[i].split(/: +/);
            if (pair[0] === 'Content-Length') {
              this._contentLength = +pair[1];
            }
          }
          this._rawData = this._rawData.slice(idx + Connection._TWO_CRLF.length);
          continue;
        }
      }
      break;
    }
  }
}
