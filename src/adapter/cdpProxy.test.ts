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
      await WebSocketTransport.create(
        `ws://${addr.host}:${addr.port}${addr.path}`,
        NeverCancelled,
      ),
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

    expect(await client.Runtime.evaluate({ expression: 'hello!' })).to.deep.equal({
      ok: true,
    });
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
        transport.injectMessage({ method, sessionId: message.sessionId, params: {} })
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

    await client.Runtime.evaluate({ expression: '' });
    expect(recv).to.be.empty;

    await client.JsDebug.subscribe({
      events: ['Debugger.*', 'Runtime.consoleAPICalled'],
    });
    await client.session.sendOrDie('Runtime.evaluate', { expression: '' });
    expect(recv).to.deep.equal(['Runtime.consoleAPICalled', 'Debugger.scriptParsed']);
  });

  describe('replays', () => {
    it('CSS', async () => {
      transport.onDidSendEmitter.event(async message => {
        await delay(0);
        transport.injectMessage({
          id: message.id as number,
          result: {},
          sessionId: message.sessionId,
        });
      });

      transport.injectMessage({
        method: 'CSS.styleSheetAdded',
        params: { styleSheetId: '42' },
        sessionId: 'sesh',
      });
      transport.injectMessage({
        method: 'CSS.styleSheetAdded',
        params: { styleSheetId: '43' },
        sessionId: 'sesh',
      });
      transport.injectMessage({
        method: 'CSS.styleSheetRemoved',
        params: { styleSheetId: '43' },
        sessionId: 'sesh',
      });

      const events: unknown[] = [];
      client.CSS.on('styleSheetAdded', evt => events.push(evt));
      client.CSS.on('styleSheetRemoved', evt => events.push(evt));

      expect(await client.CSS.enable({})).to.deep.equal({});
      expect(events).to.deep.equal([{ styleSheetId: '42' }]);
    });

    it('caps replays', async () => {
      transport.onDidSendEmitter.event(async message => {
        await delay(0);
        transport.injectMessage({
          id: message.id as number,
          result: {},
          sessionId: message.sessionId,
        });
      });

      const events: Cdp.Runtime.RemoteObject[] = [];
      client.Runtime.on('consoleAPICalled', evt => events.push(evt.args[0]));

      for (let i = 0; i < 1000; i++) {
        transport.injectMessage({
          method: 'Runtime.consoleAPICalled',
          params: { args: [{ objectId: String(i) }] },
          sessionId: 'sesh',
        });
      }

      expect(await client.Runtime.enable({})).to.deep.equal({});
      expect(events.length).to.equal(50);
      expect(events[0].objectId).to.equal('950');
      expect(events[events.length - 1].objectId).to.equal('999');
    });
  });
});
