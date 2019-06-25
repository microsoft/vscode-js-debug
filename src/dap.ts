/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { DebugProtocol } from 'vscode-debugprotocol';
import Dap from '../dap';
import * as debug from 'debug';

const debugDAP = debug('dap');

class Message implements DebugProtocol.ProtocolMessage {
  seq: number;
  type: string;

  public constructor(type: string) {
    this.seq = 0;
    this.type = type;
  }
}

class Response extends Message implements DebugProtocol.Response {
  request_seq: number;
  success: boolean;
  command: string;

  public constructor(request: DebugProtocol.Request, message?: string) {
    super('response');
    this.request_seq = request.seq;
    this.command = request.command;
    if (message) {
      this.success = false;
      (<any>this).message = message;
    } else {
      this.success = true;
    }
  }
}

class Event extends Message implements DebugProtocol.Event {
  event: string;

  public constructor(event: string, body?: any) {
    super('event');
    this.event = event;
    if (body) {
      (<any>this).body = body;
    }
  }
}

export class Connection {
  private _writableStream: NodeJS.WritableStream;
  private _parser: Parser;
  private _pendingRequests = new Map<number, (response: DebugProtocol.Response) => void>();
  private _handlers = new Map<string, (params: any) => Promise<any>>();
  private _dap: Dap.DapProxyApi;

  constructor(inStream: NodeJS.ReadableStream, outStream: NodeJS.WritableStream) {
    this._parser = new Parser(this._onMessage.bind(this));
    this._writableStream = outStream;

    inStream.on('data', (data: Buffer) => {
      this._parser.handleData(data);
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

  dap(): Dap.DapProxyApi {
    return this._dap;
  }

  _createApi(): Dap.DapProxyApi {
    return new Proxy({}, {
      get: (target, methodName: string, receiver) => {
        if (methodName === 'on')
          return (requestName, handler) => this._handlers.set(requestName, handler);
        if (methodName === 'off')
          return (requestName, handler) => this._handlers.delete(requestName);
        return params => this._sendEvent(methodName, params);
      }
    }) as Dap.DapProxyApi;
  }

  private _sendEvent(event: string, params?: any): void {
    this._writeData(this._parser.wrap('event', new Event(event, params)));
  }

  public _sendResponse(response: DebugProtocol.Response): void {
    if (response.seq > 0) {
      console.error(`attempt to send more than one response for command ${response.command}`);
      return;
    }
    this._writeData(this._parser.wrap('response', response));
  }

  /*
  private sendRequest(command: string, args: any, timeout: number): Promise<DebugProtocol.Response> {
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

  private _writeData(data: string): void {
    if (!this._writableStream) {
      console.error('Writing to a closed connection');
      return;
    }
    this._writableStream.write(data, 'utf8');
  }

  private _onMessage(msg: DebugProtocol.ProtocolMessage): void {
    if (msg.type === 'request') {
      this._dispatchRequest(<DebugProtocol.Request> msg);
    } else if (msg.type === 'response') {
      const response = <DebugProtocol.Response> msg;
      const clb = this._pendingRequests.get(response.request_seq);
      if (clb) {
        this._pendingRequests.delete(response.request_seq);
        clb(response);
      }
    }
  }

  private async _dispatchRequest(request: DebugProtocol.Request): Promise<void> {
    const response: DebugProtocol.Response = new Response(request);
    try {
      const callback = this._handlers.get(request.command);
      if (!callback) {
        console.error(`Unknown request: ${request.command}`);
        //this._sendErrorResponse(response, 1014, `Unrecognized request: ${request.command}`);
      } else {
        response.body = await callback(request.arguments);
        this._sendResponse(response);
      }
    } catch (e) {
      console.error(e);
      this._sendErrorResponse(response, 1104, `Error processing ${request.command}: ${e.stack || e.message}`);
    }
  }

  private _sendErrorResponse(response: DebugProtocol.Response, code: number, message: string): void {
    const msg : DebugProtocol.Message = {
      id: code,
      format: message
    };
    // msg.showUser = true;
    // msg.sendTelemetry = true;
    response.success = false;
    response.message = message;
    if (!response.body)
      response.body = {};
    response.body.error = msg;
    this._sendResponse(response);
  }
}

class Parser {
  private static TWO_CRLF = '\r\n\r\n';

  private _dispatchCallback: (request: DebugProtocol.ProtocolMessage) => void;
  private _rawData: Buffer;
  private _contentLength: number;
  private _sequence: number;

  constructor(dispatchCallback: (request: DebugProtocol.ProtocolMessage) => void) {
    this._dispatchCallback = dispatchCallback;
    this._sequence = 1;
    this._rawData = new Buffer(0);
  }

  public wrap(typ: 'request' | 'response' | 'event', message: DebugProtocol.ProtocolMessage): string {
    message.type = typ;
    message.seq = this._sequence++;
    const json = JSON.stringify(message);
    debugDAP('SEND ► ' + json);
    return `Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`;
  }

  public handleData(data: Buffer): void {
    this._rawData = Buffer.concat([this._rawData, data]);
    while (true) {
      if (this._contentLength >= 0) {
        if (this._rawData.length >= this._contentLength) {
          const message = this._rawData.toString('utf8', 0, this._contentLength);
          this._rawData = this._rawData.slice(this._contentLength);
          this._contentLength = -1;
          if (message.length > 0) {
            try {
              let msg: DebugProtocol.ProtocolMessage = JSON.parse(message);
              debugDAP('◀ RECV ' + msg);
              this._dispatchCallback(msg);
            }
            catch (e) {
              console.error('Error handling data: ' + (e && e.message));
            }
          }
          continue;	// there may be more complete messages to process
        }
      } else {
        const idx = this._rawData.indexOf(Parser.TWO_CRLF);
        if (idx !== -1) {
          const header = this._rawData.toString('utf8', 0, idx);
          const lines = header.split('\r\n');
          for (let i = 0; i < lines.length; i++) {
            const pair = lines[i].split(/: +/);
            if (pair[0] == 'Content-Length') {
              this._contentLength = +pair[1];
            }
          }
          this._rawData = this._rawData.slice(idx + Parser.TWO_CRLF.length);
          continue;
        }
      }
      break;
    }
  }
}
