/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { randomBytes } from 'crypto';
import { inject, injectable } from 'inversify';
import WebSocket from 'ws';
import { Cdp } from '../cdp/api';
import { ICdpApi, ProtocolError } from '../cdp/connection';
import { CdpProtocol } from '../cdp/protocol';
import { LinkedList } from '../common/datastructure/linkedList';
import { DisposableList, IDisposable } from '../common/disposable';
import { ILogger, LogTag } from '../common/logging';
import Dap from '../dap/api';
import { acquireTrackedWebSocketServer, IPortLeaseTracker } from './portLeaseTracker';

const jsDebugDomain = 'JsDebug';
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
  proxy(): Promise<Dap.RequestCDPProxyResult>;
}

type ReplayMethod = { event: string; params: Record<string, unknown> };

const enum CaptureBehavior {
  Append,
  CappedAppend,
  Replace,
}

type CaptureBehaviorParams =
  | CaptureBehavior.Append
  | CaptureBehavior.Replace
  | { type: CaptureBehavior.CappedAppend; cap: number };

/**
 * Handles replaying events from domains. Certain events are only fired when
 * a domain is first enabled, so subsequent connections may not receive it.
 */
class DomainReplays {
  private replays = new Map<keyof Cdp.Api, LinkedList<ReplayMethod>>();

  /**
   * Adds a message to be replayed.
   */
  public addReplay(domain: keyof Cdp.Api, event: string, params: unknown) {
    let ll = this.replays.get(domain);
    if (!ll) {
      ll = new LinkedList();
      this.replays.set(domain, ll);
    }

    return ll.push({ event: `${domain}.${event}`, params: params as Record<string, unknown> });
  }

  /**
   * Captures replay for the event on CDP.
   */
  public capture(
    cdp: Cdp.Api,
    domain: keyof Cdp.Api,
    event: string,
    behavior: CaptureBehaviorParams,
  ) {
    const handler = cdp[domain] as {
      on(event: string, fn: (arg: Record<string, unknown>) => void): void;
    };

    if (behavior === CaptureBehavior.Append) {
      handler.on(event, args => this.addReplay(domain, event, args));
    } else if (behavior === CaptureBehavior.Replace) {
      let rmPrevious: (() => void) | undefined;
      handler.on(event, args => {
        rmPrevious?.();
        rmPrevious = this.addReplay(domain, event, args);
      });
    } else {
      const rmQueue = new LinkedList<() => void>();
      handler.on(event, args => {
        if (rmQueue.size === behavior.cap) {
          rmQueue.shift()?.();
        }
        rmQueue.push(this.addReplay(domain, event, args));
      });
    }
  }

  /**
   * Filters replayed events.
   */
  public filter(domain: keyof Cdp.Api, filterFn: (r: ReplayMethod) => boolean) {
    const ll = this.replays.get(domain);
    if (!ll) {
      return;
    }

    ll.applyFilter(filterFn);
  }

  /**
   * Removes all of the event from the replay.
   */
  public clearEvent<TKey extends keyof Cdp.Api>(domain: TKey, event: string) {
    const e = `${domain}.${event}`;
    this.filter(domain, r => r.event !== e);
  }

  /**
   * Removes all replay info for a domain.
   */
  public clearDomain(domain: keyof Cdp.Api) {
    this.replays.delete(domain);
  }

  /**
   * Gets replay messages for the given domain.
   */
  public read(domain: keyof Cdp.Api) {
    return this.replays.get(domain) ?? [];
  }
}

export const ICdpProxyProvider = Symbol('ICdpProxyProvider');

/**
 * Implementation of the {@link ICdpProxyProvider}
 */
@injectable()
export class CdpProxyProvider implements ICdpProxyProvider {
  private server?: Promise<{ server: WebSocket.Server; path: string }>;
  private readonly disposables = new DisposableList();
  private readonly replay = new DomainReplays();

  private jsDebugApi: IJsDebugDomain = {
    /** @inheritdoc */
    subscribe: (handle, { events }) => {
      for (const event of events) {
        if (event.endsWith(eventWildcard)) {
          handle.pushDisposable(
            this.cdp.session.onPrefix(
              event.slice(0, -eventWildcard.length),
              c => handle.send({ method: c.method, params: c.params }),
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
  ) {
    this.replay.capture(cdp, 'CSS', 'styleSheetAdded', CaptureBehavior.Append);
    this.replay.capture(cdp, 'Debugger', 'paused', CaptureBehavior.Replace);
    this.replay.capture(cdp, 'Runtime', 'executionContextCreated', {
      cap: 50,
      type: CaptureBehavior.CappedAppend,
    });
    this.replay.capture(cdp, 'Runtime', 'consoleAPICalled', {
      cap: 50,
      type: CaptureBehavior.CappedAppend,
    });
    cdp.Debugger.on('resumed', () => {
      this.replay.clearEvent('Debugger', 'paused');
    });

    cdp.CSS.on('fontsUpdated', evt => {
      if (evt.font) {
        this.replay.addReplay('CSS', 'fontsUpdated', evt);
      }
    });

    cdp.CSS.on(
      'styleSheetRemoved',
      evt => this.replay.filter('CSS', s => s.params.styleSheetId !== evt.styleSheetId),
    );
  }

  /**
   * Acquires the proxy server, and returns its address.
   */
  public async proxy() {
    if (!this.server) {
      this.server = this.createServer();
    }

    const { server, path } = await this.server;
    const addr = server.address() as WebSocket.AddressInfo;
    return { host: addr.address, port: addr.port, path };
  }

  private async createServer() {
    const path = `/${randomBytes(20).toString('hex')}`;
    const server = await acquireTrackedWebSocketServer(this.portTracker, {
      perMessageDeflate: true,
      path,
    });

    this.logger.info(LogTag.ProxyActivity, 'activated cdp proxy');

    server.on('connection', client => {
      const clientHandle = new ClientHandle(client, this.logger);
      this.logger.info(LogTag.ProxyActivity, 'accepted proxy connection', {
        id: clientHandle.id,
      });

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
        const [domain, fn] = method.split('.');
        try {
          const result = domain === jsDebugDomain
            ? await this.invokeJsDebugDomainMethod(clientHandle, fn, params)
            : await this.invokeCdpMethod(clientHandle, domain, fn, params);
          clientHandle.send({ id, result });
        } catch (e) {
          const error = e instanceof ProtocolError && e.cause
            ? e.cause
            : { code: 0, message: e.message };
          clientHandle.send({ id, error });
        }
      });
    });

    return { server, path };
  }

  /**
   * @inheritdoc
   */
  public dispose() {
    this.disposables.dispose();
    this.server?.then(s => s.server.close());
    this.server = undefined;
  }

  private invokeCdpMethod(client: ClientHandle, domain: string, method: string, params: object) {
    const promise = this.cdp.session.sendOrDie(`${domain}.${method}`, params);
    switch (method) {
      case 'enable':
        for (const m of this.replay.read(domain as keyof Cdp.Api)) {
          client.send({ method: m.event, params: m.params });
        }
        break;
      case 'disable':
        this.replay.clearDomain(domain as keyof Cdp.Api);
        break;
      default:
        // no-op
    }

    // it's intentional that replay is sent before the
    // enabled response; this is what Chrome does.
    return promise;
  }

  private invokeJsDebugDomainMethod(handle: ClientHandle, method: string, params: unknown) {
    if (!this.jsDebugApi.hasOwnProperty(method)) {
      throw new ProtocolError(method).setCause(
        ProxyErrors.MethodNotFound,
        `${jsDebugDomain}.${method} not found`,
      );
    }

    type MethodMap = { [key: string]: (handle: ClientHandle, arg: unknown) => Promise<object> };
    return (this.jsDebugApi as unknown as MethodMap)[method](handle, params);
  }
}

let connectionIdCounter = 0;

class ClientHandle implements IDisposable {
  private readonly disposables = new DisposableList();
  public readonly id = connectionIdCounter++;

  constructor(readonly webSocket: WebSocket, private readonly logger: ILogger) {}

  pushDisposable(d: IDisposable): void {
    this.disposables.push(d);
  }

  dispose() {
    this.disposables.dispose();
    this.webSocket.close();
  }

  public send(message: CdpProtocol.Message) {
    this.logger.verbose(LogTag.ProxyActivity, 'send proxy message', message);
    this.webSocket.send(JSON.stringify(message));
  }
}
