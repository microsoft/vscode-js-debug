/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { Readable, Writable } from 'stream';
import { Event } from 'vscode';
import { EventEmitter } from '../common/events';
import { IDisposable } from '../common/disposable';
import { ILogger, LogTag } from '../common/logging';

const _TWO_CRLF = '\r\n\r\n';

export type Message = (
  | { type: 'request'; command: string; arguments: object }
  | {
      type: 'response';
      message?: string;
      command: string;
      request_seq: number;
      success: boolean;
      body: object;
    }
  | { type: 'event'; event: string; body: object }
) & {
  sessionId?: string;
  seq: number;
  __receivedTime?: bigint;
};

/**
 * An interface which represents the transport layer for sending/receiving DAP messages
 */
export interface IDapTransport {
  /**
   * Send a DAP message over this transport
   * @param message The DAP message to send
   * @param shouldLog Whether or not the transport layer should log this message
   */
  send(message: Message, shouldLog?: boolean): void;

  /**
   * Close the connection for this transport
   */
  close(): void;

  /**
   * Message received event. Will fire when a new DAP message has been received on this transport
   */
  messageReceived: Event<{ message: Message; receivedTime: bigint }>;

  /**
   * Closed event. Will fire when this transport has been closed
   */
  closed: Event<void>;
}

export class StreamDapTransport implements IDapTransport {
  private _rawData: Buffer;
  private _contentLength = -1;

  private msgEmitter = new EventEmitter<{ message: Message; receivedTime: bigint }>();
  messageReceived = this.msgEmitter.event;

  private endedEmitter = new EventEmitter<void>();
  closed = this.endedEmitter.event;

  constructor(
    private readonly inputStream: Readable,
    private readonly outputStream: Writable,
    protected readonly logger: ILogger,
  ) {
    this._rawData = Buffer.alloc(0);
    inputStream.on('end', () => this.endedEmitter.fire());
    inputStream.on('data', this._handleData);
  }

  send(message: Message, shouldLog = true): void {
    const json = JSON.stringify(message);
    if (shouldLog) {
      this.logger.verbose(LogTag.DapSend, undefined, { message });
    }
    const data = `Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`;
    if (this.outputStream.destroyed) {
      console.error('Writing to a closed connection');
      return;
    }
    this.outputStream.write(data, 'utf8');
  }
  close(): void {
    this.inputStream.destroy();
    this.outputStream.destroy();
  }

  _handleData = (data: Buffer): void => {
    const receivedTime = process.hrtime.bigint();
    this._rawData = Buffer.concat([this._rawData, data]);
    while (true) {
      if (this._contentLength >= 0) {
        if (this._rawData.length >= this._contentLength) {
          const message = this._rawData.toString('utf8', 0, this._contentLength);
          this._rawData = this._rawData.slice(this._contentLength);
          this._contentLength = -1;
          if (message.length > 0) {
            try {
              const msg: Message = JSON.parse(message);
              this.logger.verbose(LogTag.DapReceive, undefined, {
                message: msg,
              });
              this.msgEmitter.fire({ message: msg, receivedTime });
            } catch (e) {
              console.error('Error handling data: ' + (e && e.message));
            }
          }
          continue; // there may be more complete messages to process
        }
      } else {
        const idx = this._rawData.indexOf(_TWO_CRLF);
        if (idx !== -1) {
          const header = this._rawData.toString('utf8', 0, idx);
          const lines = header.split('\r\n');
          for (let i = 0; i < lines.length; i++) {
            const pair = lines[i].split(/: +/);
            if (pair[0] === 'Content-Length') {
              this._contentLength = +pair[1];
            }
          }
          this._rawData = this._rawData.slice(idx + _TWO_CRLF.length);
          continue;
        }
      }
      break;
    }
  };
}

/**
 * Wraps another transport and adds session ids to messages being sent,
 * and only emits messages with this transport's session id
 */
export class SessionIdDapTransport implements IDapTransport {
  sessionIdMessageEmitter = new EventEmitter<{ message: Message; receivedTime: bigint }>();
  messageReceived = this.sessionIdMessageEmitter.event;
  closedEmitter = new EventEmitter<void>();
  closed = this.closedEmitter.event;

  private _isClosed = false;

  disposables: IDisposable[] = [];

  constructor(
    public readonly sessionId: string | undefined,
    protected readonly rootTransport: IDapTransport,
  ) {
    this.disposables.push(rootTransport.messageReceived(e => this.onMessage(e)));
    this.disposables.push(rootTransport.closed(() => this.close()));
  }

  send(msg: Message, shouldLog?: boolean) {
    if (!this._isClosed) {
      msg.sessionId = this.sessionId;
      this.rootTransport.send(msg, shouldLog);
    }
  }

  onMessage(event: { message: Message; receivedTime: bigint }) {
    if (!this._isClosed && event.message.sessionId === this.sessionId) {
      this.sessionIdMessageEmitter.fire(event);
    }
  }

  close() {
    // don't actually close the root transport here, we just "disconnect" from it
    this._isClosed = true;
    this.disposables.forEach(x => x.dispose());
    this.closedEmitter.fire();
  }
}
