/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import Dap from './api';

import { ITelemetryReporter } from '../telemetry/telemetryReporter';
import { ILogger } from '../common/logging';
import { isDapError, ProtocolError } from './errors';
import { Message, IDapTransport } from './transport';
import { IDisposable } from '../common/disposable';
import { getDeferred } from '../common/promiseUtil';
import { HrTime } from '../common/hrnow';

const requestSuffix = 'Request';
export const isRequest = (req: string) => req.endsWith('Request');

/**
 * Symbol injected to get the closest DAP connection.
 */
export const IDapApi = Symbol('IDapApi');

export default class Connection {
  private static readonly logOmittedCalls = new WeakSet<object>();
  private _sequence: number;

  private telemetryReporter?: ITelemetryReporter;
  private _pendingRequests = new Map<number, (result: string | object) => void>();
  private _requestHandlers = new Map<string, (params: object) => Promise<object>>();
  private _eventListeners = new Map<string, Set<(params: object) => void>>();
  private _dap: Promise<Dap.Api>;
  private disposables: IDisposable[] = [];

  private _initialized = getDeferred<Connection>();
  /**
   * Get a promise which will resolve with this connection after the session has responded to initialize
   */
  public get initializedBlocker() {
    return this._initialized.promise;
  }

  constructor(protected readonly transport: IDapTransport, protected readonly logger: ILogger) {
    this._sequence = 1;

    this.disposables.push(
      this.transport.messageReceived(event => this._onMessage(event.message, event.receivedTime)),
    );
    this._dap = Promise.resolve(this._createApi());
  }

  public attachTelemetry(telemetryReporter: ITelemetryReporter) {
    this.telemetryReporter = telemetryReporter;
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
    this.transport.close();
  }

  _send(message: Message) {
    message.seq = this._sequence++;

    const shouldLog = message.type !== 'event' || !Connection.logOmittedCalls.has(message.body);
    this.transport.send(message, shouldLog);
  }

  async _onMessage(msg: Message, receivedTime: HrTime): Promise<void> {
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
        const callback = this._requestHandlers.get(msg.command);
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
            if (response.command === 'initialize') {
              this._initialized.resolve(this);
            }
          }
        }
        this.telemetryReporter?.reportOperation(
          'dapOperation',
          msg.command,
          receivedTime.elapsed().ms,
        );
      } catch (e) {
        if (e instanceof ProtocolError) {
          this._send({
            ...response,
            success: false,
            body: { error: e.cause },
          });
        } else {
          console.error(e);
          this._send({
            ...response,
            success: false,
            body: {
              error: {
                id: 9221,
                format: `Error processing ${msg.command}: ${e.stack || e.message}`,
                showUser: false,
                sendTelemetry: false,
              },
            },
          });
        }

        this.telemetryReporter?.reportOperation(
          'dapOperation',
          msg.command,
          receivedTime.elapsed().ms,
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
}
