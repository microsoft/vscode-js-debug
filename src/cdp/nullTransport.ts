/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { EventEmitter } from '../common/events';
import { HrTime } from '../common/hrnow';
import { CdpProtocol } from './protocol';
import { ITransport } from './transport';

export class NullTransport implements ITransport {
  public readonly onMessageEmitter = new EventEmitter<[string, HrTime]>();
  public readonly onEndEmitter = new EventEmitter<void>();
  public readonly onDidSendEmitter = new EventEmitter<CdpProtocol.Message>();

  public readonly onMessage = this.onMessageEmitter.event;
  public readonly onEnd = this.onEndEmitter.event;

  /**
   * Sends a message to the attached CDP Connection instance.
   */
  public injectMessage(message: CdpProtocol.Message) {
    this.onMessageEmitter.fire([JSON.stringify(message), new HrTime()]);
  }

  /**
   * @inheritdoc
   */
  send(message: string): void {
    this.onDidSendEmitter.fire(JSON.parse(message));
  }

  dispose(): void {
    // no-op
  }
}
