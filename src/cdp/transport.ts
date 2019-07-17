/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as net from 'net';
import * as WebSocket from 'ws';
import * as utils from '../utils';

export interface Transport {
  send(message: string): void;
  close();
  onmessage?: (message: string) => void;
  onclose?: () => void;
  clone(): Promise<Transport>;
}

export class PipeTransport implements Transport {
  private _pipeWrite: NodeJS.WritableStream | undefined;
  private _socket: net.Socket | undefined;
  private _pendingMessage: string;
  private _eventListeners: any[];
  onmessage?: (message: string) => void;
  onclose?: () => void;

  constructor(socket: net.Socket);
  constructor(pipeWrite: NodeJS.WritableStream, pipeRead: NodeJS.ReadableStream);

  constructor(pipeWrite: net.Socket | NodeJS.WritableStream, pipeRead?: NodeJS.ReadableStream) {
    this._pipeWrite = pipeWrite as NodeJS.WritableStream;
    if (!pipeRead)
      this._socket = pipeWrite as net.Socket;
    this._pendingMessage = '';
    this._eventListeners = [
      utils.addEventListener(pipeRead || pipeWrite, 'data', buffer => this._dispatch(buffer)),
      utils.addEventListener(pipeRead || pipeWrite, 'close', () => {
        this._pipeWrite = undefined;
        if (this.onclose)
          this.onclose.call(null);
      })
    ];
    this.onmessage = undefined;
    this.onclose = undefined;
  }

  send(message: string) {
    this._pipeWrite!.write(message);
    this._pipeWrite!.write('\0');
  }

  _dispatch(buffer: Buffer) {
    let end = buffer.indexOf('\0');
    if (end === -1) {
      this._pendingMessage += buffer.toString();
      return;
    }
    const message = this._pendingMessage + buffer.toString(undefined, 0, end);
    if (this.onmessage)
      this.onmessage.call(null, message);

    let start = end + 1;
    end = buffer.indexOf('\0', start);
    while (end !== -1) {
      if (this.onmessage)
        this.onmessage.call(null, buffer.toString(undefined, start, end));
      start = end + 1;
      end = buffer.indexOf('\0', start);
    }
    this._pendingMessage = buffer.toString(undefined, start);
  }

  async close() {
    if (this._socket)
      this._socket.destroy();
    this._socket = undefined;
    this._pipeWrite = undefined;
    utils.removeEventListeners(this._eventListeners);
  }

  clone(): Promise<Transport> {
    throw new Error('Not implemented');
  }
}

export class WebSocketTransport implements Transport {
  private _ws: WebSocket | undefined;
  private _wsUrl: string;
  onmessage?: (message: string) => void;
  onclose?: () => void;

  static create(url: string): Promise<WebSocketTransport> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, [], {
        perMessageDeflate: false,
        maxPayload: 256 * 1024 * 1024, // 256Mb
      });
      ws.addEventListener('open', () => resolve(new WebSocketTransport(ws, url)));
      ws.addEventListener('error', reject);
    });
  }

  constructor(ws: WebSocket, wsUrl: string) {
    this._ws = ws;
    this._wsUrl = wsUrl;
    this._ws.addEventListener('message', event => {
      if (this.onmessage)
        this.onmessage.call(null, event.data);
    });
    this._ws.addEventListener('close', event => {
      if (this.onclose)
        this.onclose.call(null);
      this._ws = undefined;
    });
    // Silently ignore all errors - we don't know what to do with them.
    this._ws.addEventListener('error', () => { });
    this.onmessage = undefined;
    this.onclose = undefined;
  }

  send(message: string) {
    if (this._ws)
      this._ws.send(message);
  }

  async close(): Promise<void> {
    if (!this._ws)
      return;
    let callback: () => void;
    const result = new Promise<void>(f => callback = f);
    this._ws.addEventListener('close', () => callback());
    this._ws.close();
    return result;
  }

  clone(): Promise<Transport> {
    return WebSocketTransport.create(this._wsUrl);
  }
}
