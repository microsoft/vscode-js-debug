/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as ProxyProtocol from 'vscode-js-debug-cdp-proxy-api';
import WebSocket from 'ws';
import { Cdp } from '../cdp/api';
import { DisposableList, IDisposable } from '../common/disposable';

export class CDPProxyServer implements IDisposable {
  private server?: WebSocket.Server;
  private readonly disposables = new DisposableList();

  constructor(private readonly cdp: Cdp.Api) {}

  address(): { host: string; port: number } | undefined {
    const address = this.server?.address();
    if (address && typeof address !== 'string') {
      return {
        host: address.address,
        port: address.port,
      };
    }
    return;
  }

  async proxy(): Promise<void> {
    if (!this.server) {
      const server = new WebSocket.Server({ port: 0 });

      server.on('connection', client => {
        const clientHandle = new ClientHandle(client);

        client.on('close', () => {
          this.disposables.disposeObject(clientHandle);
        });

        client.on('message', async d => {
          const request = parseRequest(d.toString());

          if (request) {
            try {
              switch (request.operation) {
                case ProxyProtocol.Operation.Subscribe:
                  const subscribeResult = await this.subscribeToCDP(request, clientHandle);
                  this.sendResultResponse(clientHandle, request, subscribeResult);
                  break;
                case ProxyProtocol.Operation.Send:
                  const sendResult = await this.sendToCDP(request);
                  this.sendResultResponse(clientHandle, request, sendResult);
                  break;
              }
            } catch (e) {
              this.sendErrorResponse(clientHandle, request, e.toString());
            }
          }
        });
      });

      this.server = server;
    }
  }

  dispose() {
    this.disposables.dispose();
    this.server?.close();
  }

  private async sendToCDP({
    domain,
    method,
    params,
  }: ProxyProtocol.SendRequest): Promise<Record<string, unknown>> {
    const agent = this.cdp[domain as keyof Cdp.Api];

    if (agent) {
      const fn = (agent as any)[method]; // eslint-disable-line @typescript-eslint/no-explicit-any

      if (typeof fn === 'function') {
        return await fn(params);
      } else {
        throw new Error(`Unknown method for domain "${method}"`);
      }
    } else {
      throw new Error(`Unknown domain "${domain}"`);
    }
  }

  private sendResultResponse<O extends ProxyProtocol.Operation>(
    { webSocket }: ClientHandle,
    request: ProxyProtocol.RequestMessage<O>,
    result: ProxyProtocol.IResponsePayload[O],
  ): void {
    const response: ProxyProtocol.ResponseMessage<O> = {
      requestId: request.requestId,
      result,
    };
    webSocket.send(JSON.stringify(response));
  }

  private sendErrorResponse<O extends ProxyProtocol.Operation>(
    { webSocket }: ClientHandle,
    request: ProxyProtocol.Request,
    error: string,
  ): void {
    const response: ProxyProtocol.ResponseMessage<O> = {
      requestId: request.requestId,
      error,
    };
    webSocket.send(JSON.stringify(response));
  }

  private subscribeToCDP(
    { domain, event }: ProxyProtocol.SubscribeRequest,
    clientHandle: ClientHandle,
  ) {
    if (!event) {
      throw new Error('Subscription of complete domain not implemented!');
    }

    const agent = this.cdp[domain as keyof Cdp.Api];
    if (agent) {
      const on = (agent as any).on; // eslint-disable-line @typescript-eslint/no-explicit-any

      if (typeof on === 'function') {
        clientHandle.pushDisposable(
          on(event, (data: Record<string, unknown>) =>
            this.sendEvent(clientHandle.webSocket, domain, event, data),
          ),
        );
      } else {
        throw new Error(`Domain "${domain}" does not provide event subscriptions.`);
      }
    } else {
      throw new Error(`Unknown domain "${domain}"`);
    }
  }

  private sendEvent(
    socket: WebSocket,
    domain: string,
    event: string,
    data: Record<string, unknown>,
  ) {
    const message: ProxyProtocol.IEvent = {
      domain,
      event,
      data,
    };
    socket.send(JSON.stringify(message));
  }
}

function parseRequest(raw: string): ProxyProtocol.Request | undefined {
  try {
    const json = JSON.parse(raw);
    const { operation } = json;

    if (typeof operation !== 'string') {
      return;
    }

    // TODO do proper parsing of the incoming requests JSON?
    switch (operation) {
      case ProxyProtocol.Operation.Subscribe:
        return json as ProxyProtocol.RequestMessage<ProxyProtocol.Operation.Subscribe>;
      case ProxyProtocol.Operation.Send:
        return json as ProxyProtocol.RequestMessage<ProxyProtocol.Operation.Send>;
    }
  } catch (e) {
    // Ignore requests which cannot be parsed
  }
  return;
}

class ClientHandle implements IDisposable {
  private readonly disposables: DisposableList = new DisposableList();

  constructor(readonly webSocket: WebSocket) {}

  pushDisposable(d: IDisposable): void {
    this.disposables.push(d);
  }

  dispose() {
    this.disposables.dispose();
    this.webSocket.close();
  }
}
