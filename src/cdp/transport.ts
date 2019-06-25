/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as utils from '../utils';
import * as WebSocket from 'ws';

export interface Transport {
  send(message: string): void;
  close(): void;
  onmessage?: (message: string) => void;
  onclose?: () => void;
}

export class PipeTransport implements Transport {
  private _pipeWrite: NodeJS.WritableStream | null;
  private _pendingMessage: string;
  private _eventListeners: any[];
  onmessage: (message: string) => void | null;
  onclose: () => void | null;

  constructor(pipeWrite: NodeJS.WritableStream, pipeRead: NodeJS.ReadableStream) {
    this._pipeWrite = pipeWrite;
    this._pendingMessage = '';
    this._eventListeners = [
      utils.addEventListener(pipeRead, 'data', buffer => this._dispatch(buffer)),
      utils.addEventListener(pipeRead, 'close', () => {
        if (this.onclose)
          this.onclose.call(null);
      })
    ];
    this.onmessage = null;
    this.onclose = null;
  }

  send(message: string) {
    this._pipeWrite.write(message);
    this._pipeWrite.write('\0');
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

  close() {
    this._pipeWrite = null;
    utils.removeEventListeners(this._eventListeners);
  }
}

export class WebSocketTransport implements Transport {
  private _ws: WebSocket;
  onmessage: (message: string) => void | null;
  onclose: () => void | null;

  static create(url: string): Promise<WebSocketTransport> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, [], {
        perMessageDeflate: false,
        maxPayload: 256 * 1024 * 1024, // 256Mb
      });
      ws.addEventListener('open', () => resolve(new WebSocketTransport(ws)));
      ws.addEventListener('error', reject);
    });
  }

  constructor(ws: WebSocket) {
    this._ws = ws;
    this._ws.addEventListener('message', event => {
      if (this.onmessage)
        this.onmessage.call(null, event.data);
    });
    this._ws.addEventListener('close', event => {
      if (this.onclose)
        this.onclose.call(null);
    });
    // Silently ignore all errors - we don't know what to do with them.
    this._ws.addEventListener('error', () => { });
    this.onmessage = null;
    this.onclose = null;
  }

  send(message: string) {
    this._ws.send(message);
  }

  close() {
    this._ws.close();
  }
}
