/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { ITransport } from '../../cdp/transport';
import { RawPipeTransport } from '../../cdp/rawPipeTransport';
import { PassThrough } from 'stream';
import { Logger } from '../../common/logging/logger';
import { randomBytes } from 'crypto';
import { expect } from 'chai';
import { stub } from 'sinon';
import { Server as WebSocketServer, AddressInfo } from 'ws';
import { WebSocketTransport } from '../../cdp/webSocketTransport';
import { NeverCancelled } from '../../common/cancellation';
import { GzipPipeTransport } from '../../cdp/gzipPipeTransport';
import { eventuallyOk } from '../testIntegrationUtils';

describe('cdp transport', () => {
  // cases where we create two transform streams linked to each other so that
  // messages written to one are read by the other.
  const cases: [string, () => Promise<{ a: ITransport; b: ITransport; dispose: () => void }>][] = [
    [
      'raw pipe',
      async () => {
        const aIn = new PassThrough();
        const bIn = new PassThrough();

        const a = new RawPipeTransport(Logger.null, aIn, bIn);
        const b = new RawPipeTransport(Logger.null, bIn, aIn);
        return { a, b, dispose: () => undefined };
      },
    ],
    [
      'gzip',
      async () => {
        const aIn = new PassThrough();
        const bIn = new PassThrough();

        const a = new GzipPipeTransport(Logger.null, aIn, bIn);
        const b = new GzipPipeTransport(Logger.null, bIn, aIn);
        return { a, b, dispose: () => undefined };
      },
    ],
    [
      'websocket',
      async () => {
        const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
        await new Promise<WebSocketTransport>((resolve, reject) => {
          server.on('listening', resolve);
          server.on('error', reject);
        });

        const address = server.address() as AddressInfo;
        const a = WebSocketTransport.create(`ws://127.0.0.1:${address.port}`, NeverCancelled);
        const b = new Promise<WebSocketTransport>((resolve, reject) => {
          server.on('connection', cnx => resolve(new WebSocketTransport(cnx)));
          server.on('error', reject);
        });

        return { a: await a, b: await b, dispose: () => server.close() };
      },
    ],
  ];

  for (const [name, factory] of cases) {
    describe(name, () => {
      it('round-trips', async () => {
        const rawData = randomBytes(100);
        const { a, b, dispose } = await factory();
        const actual: string[] = [];
        const expected: string[] = [];

        b.onMessage(([msg]) => actual.push(msg));

        for (let i = 0; i < rawData.length; ) {
          const consume = Math.floor(Math.random() * 20);
          const str = rawData.slice(i, i + consume).toString('base64');
          expected.push(str);
          a.send(str);
          i += consume;
        }

        await eventuallyOk(() => expect(actual).to.deep.equal(expected));
        await a.dispose();
        dispose();
      });

      it('bubbles closure', async () => {
        const { a, b, dispose } = await factory();
        const aClose = stub();
        const bClose = stub();
        a.onEnd(aClose);
        b.onEnd(bClose);
        await a.dispose();

        await eventuallyOk(() => expect(aClose.called).to.be.true);
        await eventuallyOk(() => expect(bClose.called).to.be.true);
        dispose();
      });
    });
  }
});
