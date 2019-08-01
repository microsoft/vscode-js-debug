// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import Dap from './api';
import { debug } from 'debug';

const debugDAP = debug('dap');

interface Message {
  seq: number;
  type: string;
  command?: string;
  event?: string;
  body?: any;
  arguments?: any;
  request_seq?: number;
  success?: boolean;
  message?: string;
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
  private _dap: Dap.Api;

  constructor(inStream: NodeJS.ReadableStream, outStream: NodeJS.WritableStream) {
    this._writableStream = outStream;
    this._sequence = 1;
    this._rawData = new Buffer(0);

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

    this._dap = this._createApi();
  }

  public dap(): Dap.Api {
    return this._dap;
  }

  _createApi(): Dap.Api {
    return new Proxy({}, {
      get: (target, methodName: string, receiver) => {
        if (methodName === 'on') {
          return (requestName: string, handler: (params: any) => Promise<any>) => {
            this._requestHandlers.set(requestName, handler);
            return () => this._requestHandlers.delete(requestName);
          }
        }
        if (methodName === 'off')
          return (requestName: string, handler: () => void) => this._requestHandlers.delete(requestName);
        return (params?: object) => {
          const e = { seq: 0, type: 'event', event: methodName, body: params };
          this._send(e);
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
      get: (target, methodName: string, receiver) => {
        if (methodName === 'on')
          return on;
        if (methodName === 'off')
          return off;
        if (methodName === 'once')
          return once;
        return (params?: object) => {
          return new Promise(cb => {
            const request: Message = { seq: 0, type: 'request', command: methodName };
            if (params && Object.keys(params).length > 0)
              request.arguments = params;
            this._pendingRequests.set(this._sequence, cb);
            this._send(request);
          });
        };
      }
    }) as Dap.TestApi;
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
    debugDAP('SEND ► ' + json);
    const data = `Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`;
    if (!this._writableStream) {
      console.error('Writing to a closed connection');
      return;
    }
    this._writableStream.write(data, 'utf8');
  }

  async _onMessage(msg: Message): Promise<void> {
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
    this._rawData = Buffer.concat([this._rawData, data]);
    while (true) {
      if (this._contentLength >= 0) {
        if (this._rawData.length >= this._contentLength) {
          const message = this._rawData.toString('utf8', 0, this._contentLength);
          this._rawData = this._rawData.slice(this._contentLength);
          this._contentLength = -1;
          if (message.length > 0) {
            try {
              let msg: Message = JSON.parse(message);
              debugDAP('◀ RECV ' + msg);
              this._onMessage(msg);
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
