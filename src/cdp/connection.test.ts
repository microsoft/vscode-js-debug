/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { expect } from 'chai';
import { Logger } from '../common/logging/logger';
import { NullTelemetryReporter } from '../telemetry/nullTelemetryReporter';
import Connection from './connection';
import { NullTransport } from './nullTransport';

describe('Connection', () => {
  let transport: NullTransport;
  let connection: Connection;

  const inject = (method: string, sessionId: string) =>
    transport.injectMessage({ method, params: {}, sessionId });
  const nextTask = () => new Promise(resolve => setImmediate(resolve));

  beforeEach(() => {
    transport = new NullTransport();
    connection = new Connection(transport, Logger.null, new NullTelemetryReporter());
  });

  afterEach(() => connection.close());

  it('delivers messages that arrive before their session is created', async () => {
    const methods = [
      'Inspector.workerScriptLoaded',
      'Runtime.executionContextsCleared',
      'Inspector.detached',
    ];
    inject(methods[0], 'worker');
    inject(methods[1], 'worker');

    const received: string[] = [];
    const worker = connection.createSession('worker').session;
    for (const method of methods) worker.on(method, () => received.push(method));
    inject(methods[2], 'worker');

    for (let i = 0; i < methods.length; i++) await nextTask();
    expect(received).to.deep.equal(methods);
  });

  it('keeps delivering messages after one for a session that is not created yet', () => {
    inject('Inspector.workerScriptLoaded', 'worker');

    let detached = false;
    connection.createSession('page').Inspector.on('detached', () => (detached = true));
    inject('Inspector.detached', 'page');

    expect(detached).to.equal(true);
  });

  it('keeps delivering early messages after a listener throws', async () => {
    inject('Inspector.workerScriptLoaded', 'worker');
    inject('Inspector.detached', 'worker');

    let detached = false;
    const worker = connection.createSession('worker');
    worker.session.on('Inspector.workerScriptLoaded', () => {
      throw new Error('listener failed');
    });
    worker.Inspector.on('detached', () => (detached = true));

    await nextTask();
    await nextTask();
    expect(detached).to.equal(true);
  });

  it('does not deliver early messages after the session is disposed', async () => {
    inject('Inspector.detached', 'worker');

    let detached = false;
    connection.createSession('worker').Inspector.on('detached', () => (detached = true));
    connection.disposeSession('worker');

    await nextTask();
    expect(detached).to.equal(false);
  });
});
