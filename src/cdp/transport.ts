// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as utils from '../utils';
import * as WebSocket from 'ws';

export interface Transport {
  send(message: string): void;
  close(): Promise<void>;
  onmessage?: (message: string) => void;
  onclose?: () => void;
  clone(): Promise<Transport>;
}

export class PipeTransport implements Transport {
  private _pipeWrite?: NodeJS.WritableStream;
  private _pipeRead?: NodeJS.ReadableStream;
  private _pendingMessage: string;
  private _eventListeners: any[];
  onmessage?: (message: string) => void;
  onclose?: () => void;

  constructor(pipeWrite: NodeJS.WritableStream, pipeRead: NodeJS.ReadableStream) {
    this._pipeWrite = pipeWrite;
    this._pipeRead = pipeRead;
    this._pendingMessage = '';
    this._eventListeners = [
      utils.addEventListener(pipeRead, 'data', buffer => this._dispatch(buffer)),
      utils.addEventListener(pipeRead, 'close', () => {
        this._pipeWrite = undefined;
        this._pipeRead = undefined;
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

  async close(): Promise<void> {
    if (!this._pipeRead)
      return;
    let callback: () => void;
    const result = new Promise<void>(f => callback = f);
    utils.addEventListener(this._pipeRead!, 'close', () => callback());
    this._pipeWrite = undefined;
    this._pipeRead = undefined;
    utils.removeEventListeners(this._eventListeners);
    return result;
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
