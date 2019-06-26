/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import Dap from './api';
import * as debug from 'debug';

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

  private _writableStream: NodeJS.WritableStream;
  private _rawData: Buffer;
  private _contentLength: number;
  private _sequence: number;

  private _pendingRequests = new Map<number, (response: Message) => void>();
  private _handlers = new Map<string, (params: any) => Promise<any>>();
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
        if (methodName === 'on')
          return (requestName, handler) => this._handlers.set(requestName, handler);
        if (methodName === 'off')
          return (requestName, handler) => this._handlers.delete(requestName);
        return params => {
          const e = {seq: 0, type: 'event', event: methodName, body: params};
          this._send(e);
        };
      }
    }) as Dap.Api;
  }

  /*
  private sendRequest(command: string, args: any, timeout: number): Promise<Message> {
    const request: any = { command };
    if (args && Object.keys(args).length > 0)
      request.arguments = args;
    this._writeData(this._parser.wrap('request', request));

    return new Promise(cb => {
      this._pendingRequests.set(request.seq, cb);

      const timer = setTimeout(() => {
        clearTimeout(timer);
        const clb = this._pendingRequests.get(request.seq);
        if (clb) {
          this._pendingRequests.delete(request.seq);
          clb(new Response(request, 'timeout'));
        }
      }, timeout);
    });
  }
  */

  public stop(): void {
    if (this._writableStream) {
      this._writableStream.end();
      this._writableStream = null;
    }
  }

  _send(message: Message): string {
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
      const response = {seq: 0, type: 'response', request_seq: msg.seq, command: msg.command, success: true, body: undefined};
      try {
        const callback = this._handlers.get(msg.command!);
        if (!callback) {
          response.success = false;
          response.body = {error: {
            id: 9220,
            format: `Unrecognized request: ${msg.command}`,
            showUser: false,
            sendTelemetry: false
          }};
          console.error(`Unknown request: ${msg.command}`);
          // this._send(response);
        } else {
          const result = await callback(msg.arguments!);
          if (result.__errorMarker) {
            response.success = false;
            response.body = {error: result.error};
          } else {
            response.body = result;
            this._send(response);
          }
        }
      } catch (e) {
        console.error(e);
        response.success = false;
        response.body = {error: {
          id: 9221,
          format: `Error processing ${msg.command}: ${e.stack || e.message}`,
          showUser: false,
          sendTelemetry: false
        }};
        this._send(response);
      }
    } else if (msg.type === 'response') {
      const clb = this._pendingRequests.get(msg.request_seq);
      if (clb) {
        this._pendingRequests.delete(msg.request_seq);
        clb(msg);
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
            if (pair[0] == 'Content-Length') {
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
