/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { inject, injectable } from 'inversify';
import WebSocket from 'ws';
import { Cdp } from '../cdp/api';
import { ICdpApi, ProtocolError } from '../cdp/connection';
import { CdpProtocol } from '../cdp/protocol';
import { DisposableList, IDisposable } from '../common/disposable';
import { ILogger, LogTag } from '../common/logging';
import { acquireTrackedWebSocketServer, IPortLeaseTracker } from './portLeaseTracker';

const jsDebugDomain = 'JsDebug';
const jsDebugMethodPrefix = jsDebugDomain + '.';
const eventWildcard = '*';

/**
 * Method domain under the `jsDebugDomain`.
 * @todo move to external protocol package
 */
interface IJsDebugDomain {
  /**
   * Subscribes to the given CDP event. Events will not be sent through the
   * connection unless you subscribe to them. Supports wildcards, for example
   * you can subscribe to `Debugger.scriptParsed` or `Debugger.*`
   * @param event event to subscribe to
   */
  subscribe(handle: ClientHandle, params: { events: string[] }): {};
}

// @see https://source.chromium.org/chromium/chromium/src/+/master:v8/third_party/inspector_protocol/crdtp/dispatch.h;drc=3573d5e0faf3098600993625b3f07b83f8753867
const enum ProxyErrors {
  ParseError = -32700,
  InvalidRequest = -32600,
  MethodNotFound = -32601,
  InvalidParams = -32602,
  InternalError = -32603,
  ServerError = -32000,
}

const readAddress = (server: WebSocket.Server) => {
  const addr = server.address() as WebSocket.AddressInfo;
  return { host: addr.address, port: addr.port };
};

/**
 * Implementation for the adapter-side of a CDP proxy server. A proxy server
 * is unique per debug session and target, and is therefore associated with
 * a single CDP session.
 *
 * @see https://github.com/microsoft/vscode-js-debug/issues/893
 */
export interface ICdpProxyProvider extends IDisposable {
  /**
   * Acquires the proxy server, and returns its address.
   */
  proxy(): Promise<{ host: string; port: number }>;
}

export const ICdpProxyProvider = Symbol('ICdpProxyProvider');

/**
 * Implementation of the {@link ICdpProxyProvider}
 */
@injectable()
export class CdpProxyProvider implements ICdpProxyProvider {
  private server?: WebSocket.Server;
  private readonly disposables = new DisposableList();

  private jsDebugApi: IJsDebugDomain = {
    /** @inheritdoc */
    subscribe: (handle, { events }) => {
      for (const event of events) {
        if (event.endsWith(eventWildcard)) {
          handle.pushDisposable(
            this.cdp.session.onPrefix(event.slice(0, -eventWildcard.length), c =>
              handle.send({ method: c.method, params: c.params }),
            ),
          );
        } else {
          handle.pushDisposable(
            this.cdp.session.on(event, params => handle.send({ method: event, params })),
          );
        }
      }

      return {};
    },
  };

  constructor(
    @inject(ICdpApi) private readonly cdp: Cdp.Api,
    @inject(IPortLeaseTracker) private readonly portTracker: IPortLeaseTracker,
    @inject(ILogger) private readonly logger: ILogger,
  ) {}

  /**
   * Acquires the proxy server, and returns its address.
   */
  public async proxy() {
    if (this.server) {
      return readAddress(this.server);
    }

    const server = (this.server = await acquireTrackedWebSocketServer(this.portTracker, {
      perMessageDeflate: true,
    }));

    this.logger.info(LogTag.ProxyActivity, 'activated cdp proxy');

    server.on('connection', client => {
      const clientHandle = new ClientHandle(client);
      this.logger.info(LogTag.ProxyActivity, 'accepted proxy connection', { id: clientHandle.id });

      client.on('close', () => {
        this.logger.verbose(LogTag.ProxyActivity, 'closed proxy connection', {
          id: clientHandle.id,
        });
        this.disposables.disposeObject(clientHandle);
      });

      client.on('message', async d => {
        let message: CdpProtocol.ICommand;
        try {
          message = JSON.parse(d.toString());
        } catch (e) {
          return clientHandle.send({
            id: 0,
            error: { code: ProxyErrors.ParseError, message: e.message },
          });
        }

        this.logger.verbose(LogTag.ProxyActivity, 'received proxy message', message);

        const { method, params, id = 0 } = message;
        try {
          const result = method.startsWith(jsDebugMethodPrefix)
            ? await this.invokeJsDebugDomainMethod(
                clientHandle,
                method.slice(jsDebugMethodPrefix.length),
                params,
              )
            : await this.cdp.session.sendOrDie(method, params);
          clientHandle.send({ id, result });
        } catch (e) {
          const error =
            e instanceof ProtocolError && e.cause ? e.cause : { code: 0, message: e.message };
          clientHandle.send({ id, error });
        }
      });
    });

    return readAddress(this.server);
  }

  /**
   * @inheritdoc
   */
  public dispose() {
    this.disposables.dispose();
    this.server?.close();
    this.server = undefined;
  }

  private invokeJsDebugDomainMethod(handle: ClientHandle, method: string, params: unknown) {
    if (!this.jsDebugApi.hasOwnProperty(method)) {
      throw new ProtocolError(method).setCause(
        ProxyErrors.MethodNotFound,
        `${jsDebugMethodPrefix}${method} not found`,
      );
    }

    type MethodMap = { [key: string]: (handle: ClientHandle, arg: unknown) => Promise<object> };
    return ((this.jsDebugApi as unknown) as MethodMap)[method](handle, params);
  }
}

let connectionIdCounter = 0;

class ClientHandle implements IDisposable {
  private readonly disposables = new DisposableList();
  public readonly id = connectionIdCounter++;

  constructor(readonly webSocket: WebSocket) {}

  pushDisposable(d: IDisposable): void {
    this.disposables.push(d);
  }

  dispose() {
    this.disposables.dispose();
    this.webSocket.close();
  }

  public send(message: CdpProtocol.Message) {
    this.webSocket.send(JSON.stringify(message));
  }
}
