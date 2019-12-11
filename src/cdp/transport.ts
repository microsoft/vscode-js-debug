/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as net from 'net';
import WebSocket from 'ws';
import * as events from 'events';
import { HighResolutionTime } from '../utils/performance';
import { CancellationToken } from 'vscode';
import { timeoutPromise } from '../common/cancellation';
import { logger } from '../common/logging/logger';
import { LogTag } from '../common/logging';

export interface ITransport {
  send(message: string): void;
  close(): void;
  onmessage?: (message: string, receivedTime: HighResolutionTime) => void;
  onend?: () => void;
}

export class PipeTransport implements ITransport {
  private _pipeWrite: NodeJS.WritableStream | undefined;
  private _socket: net.Socket | undefined;
  private _pendingBuffers: Buffer[];
  private _eventListeners: any[];
  onmessage?: (message: string, receivedTime: HighResolutionTime) => void;
  onend?: () => void;

  constructor(socket: net.Socket);
  constructor(pipeWrite: NodeJS.WritableStream, pipeRead: NodeJS.ReadableStream);

  constructor(pipeWrite: net.Socket | NodeJS.WritableStream, pipeRead?: NodeJS.ReadableStream) {
    this._pipeWrite = pipeWrite as NodeJS.WritableStream;
    if (!pipeRead) this._socket = pipeWrite as net.Socket;

    this._pendingBuffers = [];
    this._eventListeners = [
      addEventListener(pipeRead || pipeWrite, 'data', buffer => this._dispatch(buffer)),
      addEventListener(pipeWrite, 'end', () => this._onPipeEnd()),
      // Suppress pipe errors, e.g. EPIPE when pipe is destroyed with buffered data
      addEventListener(pipeWrite, 'error', err =>
        logger.error(LogTag.Internal, 'pipeWrite error: ' + err),
      ),
    ];
    if (pipeRead) {
      this._eventListeners.push(addEventListener(pipeRead, 'end', () => this._onPipeEnd()));
      this._eventListeners.push(
        addEventListener(pipeRead, 'error', err =>
          logger.error(LogTag.Internal, 'pipeRead error: ' + err),
        ),
      );
    }

    this.onmessage = undefined;
    this.onend = undefined;
  }

  private _onPipeEnd(): void {
    if (this._pipeWrite) {
      this._pipeWrite = undefined;
      if (this.onend) this.onend.call(null);
    }
  }

  send(message: string) {
    if (!this._pipeWrite)
      // Handle this in place, otherwise the socket will fire an unhandled error
      throw new Error('Tried to write to stream after end');

    this._pipeWrite.write(message);
    this._pipeWrite.write('\0');
  }

  _dispatch(buffer: Buffer) {
    const receivedTime = process.hrtime();
    let end = buffer.indexOf('\0');
    if (end === -1) {
      this._pendingBuffers.push(buffer);
      return;
    }
    this._pendingBuffers.push(buffer.slice(0, end));
    const message = Buffer.concat(this._pendingBuffers).toString();
    if (this.onmessage) this.onmessage.call(null, message, receivedTime);

    let start = end + 1;
    end = buffer.indexOf('\0', start);
    while (end !== -1) {
      if (this.onmessage)
        this.onmessage.call(null, buffer.toString(undefined, start, end), receivedTime);
      start = end + 1;
      end = buffer.indexOf('\0', start);
    }
    this._pendingBuffers = [buffer.slice(start)];
  }

  async close() {
    if (this._socket) this._socket.destroy();
    this._socket = undefined;
    this._pipeWrite = undefined;
    removeEventListeners(this._eventListeners);
  }
}

export class WebSocketTransport implements ITransport {
  private _ws: WebSocket | undefined;
  onmessage?: (message: string) => void;
  onend?: () => void;

  static create(url: string, cancellationToken: CancellationToken): Promise<WebSocketTransport> {
    const ws = new WebSocket(url, [], {
      perMessageDeflate: false,
      maxPayload: 256 * 1024 * 1024, // 256Mb
    });

    return timeoutPromise(
      new Promise<WebSocketTransport>((resolve, reject) => {
        ws.addEventListener('open', () => resolve(new WebSocketTransport(ws)));
        ws.addEventListener('error', reject);
      }),
      cancellationToken,
      `Could not open ${url}`,
    ).catch(err => {
      ws.close();
      throw err;
    });
  }

  constructor(ws: WebSocket) {
    this._ws = ws;
    this._ws.addEventListener('message', event => {
      if (this.onmessage) this.onmessage.call(null, event.data);
    });
    this._ws.addEventListener('close', event => {
      if (this.onend) this.onend.call(null);
      this._ws = undefined;
    });
    this._ws.addEventListener('error', () => {
      // Silently ignore all errors - we don't know what to do with them.
    });
    this.onmessage = undefined;
    this.onend = undefined;
  }

  send(message: string) {
    if (this._ws) this._ws.send(message);
  }

  async close(): Promise<void> {
    if (!this._ws) return;
    let callback: () => void;
    const result = new Promise<void>(f => (callback = f));
    this._ws.addEventListener('close', () => callback());
    this._ws.close();
    return result;
  }
}

type HandlerFunction = (...args: any[]) => void;

export interface IListener {
  emitter: events.EventEmitter;
  eventName: string;
  handler: HandlerFunction;
}

export function addEventListener(
  emitter: events.EventEmitter,
  eventName: string,
  handler: HandlerFunction,
): IListener {
  emitter.on(eventName, handler);
  return { emitter, eventName, handler };
}

export function removeEventListeners(listeners: IListener[]) {
  for (const listener of listeners)
    listener.emitter.removeListener(listener.eventName, listener.handler);
  listeners.splice(0, listeners.length);
}
