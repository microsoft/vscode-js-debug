/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { expect } from 'chai';
import { EventEmitter } from '../common/events';
import { HrTime } from '../common/hrnow';
import { ILogger } from '../common/logging';
import { Logger } from '../common/logging/logger';
import Connection from './connection';
import { IDapTransport, Message } from './transport';

class TestTransport implements IDapTransport {
  public readonly sent: Message[] = [];
  private readonly messageEmitter = new EventEmitter<{ message: Message; receivedTime: HrTime }>();
  private readonly closedEmitter = new EventEmitter<void>();

  public readonly messageReceived = this.messageEmitter.event;
  public readonly closed = this.closedEmitter.event;

  public send(message: Message, _shouldLog?: boolean, onDidWrite?: () => void): void {
    this.sent.push(message);
    onDidWrite?.();
  }

  public close(): void {
    this.closedEmitter.fire();
  }

  public setLogger(_logger: ILogger): IDapTransport {
    return this;
  }

  public receive(message: Message): void {
    this.messageEmitter.fire({ message, receivedTime: new HrTime() });
  }
}

const untilSent = async (transport: TestTransport, count: number) => {
  for (let i = 0; i < 50 && transport.sent.length < count; i++) {
    await new Promise(resolve => setImmediate(resolve));
  }
};

describe('dap connection', () => {
  let transport: TestTransport;
  let connection: Connection;

  beforeEach(() => {
    transport = new TestTransport();
    connection = new Connection(transport, Logger.null);
  });

  it('responds to a request that has a handler', async () => {
    connection.dap().on('threads', async () => ({ threads: [] }));

    transport.receive({ type: 'request', seq: 1, command: 'threads', arguments: {} });
    await untilSent(transport, 1);

    expect(transport.sent).to.have.lengthOf(1);
    expect(transport.sent[0]).to.containSubset({
      type: 'response',
      request_seq: 1,
      command: 'threads',
      success: true,
      body: { threads: [] },
    });
  });

  it('responds with an error to a request that has no handler', async () => {
    const original = console.error;
    console.error = () => undefined;
    try {
      transport.receive({ type: 'request', seq: 7, command: 'notARequest', arguments: {} });
      await untilSent(transport, 1);
    } finally {
      console.error = original;
    }

    expect(transport.sent).to.have.lengthOf(1);
    expect(transport.sent[0]).to.containSubset({
      type: 'response',
      request_seq: 7,
      command: 'notARequest',
      success: false,
      message: 'Unknown request: notARequest',
      body: { error: { format: 'Unknown request: notARequest', showUser: false } },
    });
  });
});
