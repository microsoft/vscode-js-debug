/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import Dap from './api';

import { TelemetryReporter } from '../telemetry/telemetryReporter';
import { LogTag, ILogger } from '../common/logging';
import { isDapError, isExternalError, ProtocolError } from './errors';

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

const requestSuffix = 'Request';
export const isRequest = (req: string) => req.endsWith('Request');

let connectionId = 0;

/**
 * Symbol injected to get the closest DAP connection.
 */
export const IDapApi = Symbol('IDapApi');

export default class Connection {
  private static _TWO_CRLF = '\r\n\r\n';
  private static readonly logOmittedCalls = new WeakSet<object>();

  private _connectionId = connectionId++;
  private _writableStream?: NodeJS.WritableStream;
  private _rawData: Buffer;
  private _contentLength = -1;
  private _sequence: number;

  private _pendingRequests = new Map<number, (result: string | object) => void>();
  private _requestHandlers = new Map<string, (params: object) => Promise<object>>();
  private _eventListeners = new Map<string, Set<(params: object) => void>>();
  private _dap: Promise<Dap.Api>;

  protected _ready: (dap: Dap.Api) => void;

  constructor(
    protected readonly telemetryReporter: TelemetryReporter,
    protected readonly logger: ILogger,
  ) {
    this._sequence = 1;
    this._rawData = Buffer.alloc(0);
    this._ready = () => {
      /* no-op */
    };
    this._dap = new Promise<Dap.Api>(f => (this._ready = f));
    this._dap.then(dap => telemetryReporter.attachDap(dap));
  }

  /**
   * Omits logging a call when the given object is used as parameters for
   * a method call. This is, at the moment, solely used to prevent logging
   * log output and getting into an feedback loop with the ConsoleLogSink.
   */
  public static omitLoggingFor<T extends object>(obj: T): T {
    Connection.logOmittedCalls.add(obj);
    return obj;
  }

  public init(inStream: NodeJS.ReadableStream, outStream: NodeJS.WritableStream) {
    this._writableStream = outStream;
    inStream.on('data', (data: Buffer) => {
      this._handleData(data);
    });
    inStream.on('close', () => {
      /* no-op */
    });
    inStream.on('error', () => {
      // error.message
    });
    outStream.on('error', () => {
      // error.message
    });
    inStream.resume();
    const dap = this._createApi();
    this._ready(dap);
  }

  public dap(): Promise<Dap.Api> {
    return this._dap;
  }

  _createApi(): Dap.Api {
    return new Proxy(
      {},
      {
        get: (_target, methodName: string) => {
          if (methodName === 'then') return;
          if (methodName === 'on') {
            return (requestName: string, handler: (params: object) => Promise<object>) => {
              this._requestHandlers.set(requestName, handler);
              return () => this._requestHandlers.delete(requestName);
            };
          }
          if (methodName === 'off')
            return (requestName: string) => this._requestHandlers.delete(requestName);
          return (params: object) => {
            if (isRequest(methodName)) {
              return this.enqueueRequest(methodName.slice(0, -requestSuffix.length), params);
            }

            this._send({ seq: 0, type: 'event', event: methodName, body: params });
          };
        },
      },
    ) as Dap.Api;
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
      if (listeners) listeners.delete(listener);
    };
    const once = (eventName: string, filter: (params?: object) => boolean) => {
      return new Promise(cb => {
        const listener = (params?: object) => {
          if (filter && !filter(params)) return;
          off(eventName, listener);
          cb(params);
        };
        on(eventName, listener);
      });
    };
    return new Proxy(
      {},
      {
        get: (_target, methodName: string) => {
          if (methodName === 'on') return on;
          if (methodName === 'off') return off;
          if (methodName === 'once') return once;
          return (params?: object) => this.enqueueRequest(methodName, params);
        },
      },
    ) as Dap.TestApi;
  }

  private enqueueRequest(command: string, params?: object) {
    return new Promise(cb => {
      const request: Message = { seq: 0, type: 'request', command, arguments: params || {} };
      this._send(request); // this updates request.seq
      this._pendingRequests.set(request.seq, cb);
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

    if (message.type !== 'event' || !Connection.logOmittedCalls.has(message.body)) {
      this.logger.verbose(LogTag.DapSend, undefined, { connectionId: this._connectionId, message });
    }

    const data = `Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`;
    if (!this._writableStream) {
      console.error('Writing to a closed connection');
      return;
    }
    this._writableStream.write(data, 'utf8');
  }

  async _onMessage(msg: Message, receivedTime: bigint): Promise<void> {
    if (msg.type === 'request') {
      const response = {
        seq: 0,
        type: 'response' as const,
        // eslint-disable-next-line @typescript-eslint/camelcase
        request_seq: msg.seq,
        command: msg.command,
        success: true,
      };

      try {
        const callback = msg.command && this._requestHandlers.get(msg.command);
        if (!callback) {
          console.error(`Unknown request: ${msg.command}`);
        } else {
          const result = await callback(msg.arguments);
          if (isDapError(result)) {
            this._send({
              ...response,
              success: false,
              message: result.error.format,
              body: { error: result.error },
            });
          } else {
            this._send({ ...response, body: result });
          }
        }
        this.telemetryReporter?.reportOperation(
          'dapOperation',
          msg.command,
          Number(process.hrtime.bigint() - receivedTime) / 1e6,
        );
      } catch (e) {
        console.error(e);
        const format = isExternalError(e)
          ? e.message
          : `Error processing ${msg.command}: ${e.stack || e.message}`;

        if (e instanceof ProtocolError) {
          this._send({
            ...response,
            success: false,
            body: { error: e.cause },
          });
        } else {
          this._send({
            ...response,
            success: false,
            body: {
              error: {
                id: 9221,
                format,
                showUser: false,
                sendTelemetry: false,
              },
            },
          });
        }

        this.telemetryReporter?.reportOperation(
          'dapOperation',
          msg.command,
          Number(process.hrtime.bigint() - receivedTime) / 1e6,
          e,
        );
      }
    }
    if (msg.type === 'event') {
      const listeners = this._eventListeners.get(msg.event) || new Set();
      for (const listener of listeners) listener(msg.body);
    }
    if (msg.type === 'response') {
      const cb = this._pendingRequests.get(msg.request_seq);
      if (!this.logger.assert(cb, `Expected callback for request sequence ID ${msg.request_seq}`)) {
        return;
      }

      this._pendingRequests.delete(msg.request_seq);
      if (msg.success) {
        cb(msg.body);
      } else {
        // eslint-disable-next-line
        const format: string | undefined = (msg.body as any)?.error?.format;
        cb(format || msg.message || `Unknown error`);
      }
    }
  }

  _handleData(data: Buffer): void {
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
                connectionId: this._connectionId,
                message: msg,
              });
              this._onMessage(msg, receivedTime);
            } catch (e) {
              console.error('Error handling data: ' + (e && e.message));
            }
          }
          continue; // there may be more complete messages to process
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
