/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { expect } from 'chai';
import Cdp from '../cdp/api';
import Connection, { ProtocolError } from '../cdp/connection';
import { NullTransport } from '../cdp/nullTransport';
import { CdpProtocol } from '../cdp/protocol';
import { WebSocketTransport } from '../cdp/webSocketTransport';
import { NeverCancelled } from '../common/cancellation';
import { Logger } from '../common/logging/logger';
import { delay } from '../common/promiseUtil';
import { NullTelemetryReporter } from '../telemetry/nullTelemetryReporter';
import { CdpProxyProvider } from './cdpProxy';
import { PortLeaseTracker } from './portLeaseTracker';

describe('CdpProxyProvider', () => {
  let transport: NullTransport;
  let provider: CdpProxyProvider;
  let clientConn: Connection;
  let client: Cdp.Api;

  beforeEach(async () => {
    transport = new NullTransport();
    const cdp = new Connection(transport, Logger.null, new NullTelemetryReporter());
    provider = new CdpProxyProvider(
      cdp.createSession('sesh'),
      new PortLeaseTracker('local'),
      Logger.null,
    );

    const addr = await provider.proxy();
    clientConn = new Connection(
      await WebSocketTransport.create(`ws://${addr.host}:${addr.port}`, NeverCancelled),
      Logger.null,
      new NullTelemetryReporter(),
    );

    client = clientConn.rootSession();
  });

  afterEach(() => Promise.all([clientConn.close(), provider.dispose()]));

  it('round trips a request', async () => {
    transport.onDidSendEmitter.event(async message => {
      const cast = message as CdpProtocol.ICommand;
      expect(cast.id).to.be.a('number');
      expect(cast.method).to.equal('Runtime.evaluate');
      expect(cast.params).to.deep.equal({ expression: 'hello!' });
      await delay(0);
      transport.injectMessage({
        id: cast.id as number,
        result: { ok: true },
        sessionId: message.sessionId,
      });
    });

    expect(await client.Runtime.evaluate({ expression: 'hello!' })).to.deep.equal({ ok: true });
  });

  it('bubbles errors', async () => {
    transport.onDidSendEmitter.event(async message => {
      await delay(0);
      transport.injectMessage({
        id: message.id as number,
        error: { code: 1234, message: 'something went wrong' },
        sessionId: message.sessionId,
      });
    });

    try {
      await client.session.sendOrDie('Runtime.evaluate', { expression: 'hello!' });
      throw new Error('expected to reject');
    } catch (e) {
      if (!(e instanceof ProtocolError)) {
        throw e;
      }

      expect(e.cause).to.deep.equal({ code: 1234, message: 'something went wrong' });
    }
  });

  it('deals with unknown method in JsDebug domain', async () => {
    try {
      await client.session.sendOrDie('JsDebug.constructor', {});
      throw new Error('expected to reject');
    } catch (e) {
      if (!(e instanceof ProtocolError)) {
        throw e;
      }

      expect(e.cause).to.deep.equal({ code: -32601, message: 'JsDebug.constructor not found' });
    }
  });

  it('subscribes', async () => {
    transport.onDidSendEmitter.event(async message => {
      await delay(0);
      [
        'Runtime.consoleAPICalled',
        'Runtime.exceptionThrown',
        'Debugger.scriptParsed',
        'Animation.animationStarted',
      ].forEach(method =>
        transport.injectMessage({ method, sessionId: message.sessionId, params: {} }),
      );

      transport.injectMessage({
        id: message.id as number,
        result: { ok: true },
        sessionId: message.sessionId,
      });
    });

    const recv: string[] = [];
    client.Runtime.on('consoleAPICalled', () => recv.push('Runtime.consoleAPICalled'));
    client.Runtime.on('exceptionThrown', () => recv.push('Runtime.exceptionThrown'));
    client.Debugger.on('scriptParsed', () => recv.push('Debugger.scriptParsed'));
    client.Animation.on('animationStarted', () => recv.push('Animation.animationStarted'));

    await client.session.sendOrDie('Runtime.evaluate', { expression: '' });
    expect(recv).to.be.empty;

    await client.session.sendOrDie('JsDebug.subscribe', {
      events: ['Debugger.*', 'Runtime.consoleAPICalled'],
    });
    await client.session.sendOrDie('Runtime.evaluate', { expression: '' });
    expect(recv).to.deep.equal(['Runtime.consoleAPICalled', 'Debugger.scriptParsed']);
  });
});
