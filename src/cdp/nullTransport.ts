/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { EventEmitter } from '../common/events';
import { HrTime } from '../common/hrnow';
import { ITransport } from './transport';

export class NullTransport implements ITransport {
  public readonly onMessageEmitter = new EventEmitter<[string, HrTime]>();
  public readonly onEndEmitter = new EventEmitter<void>();
  public readonly onDidSendEmitter = new EventEmitter<void>();

  public readonly onMessage = this.onMessageEmitter.event;
  public readonly onEnd = this.onEndEmitter.event;

  send(message: string): void {
    this.onDidSendEmitter.fire(JSON.parse(message));
  }

  dispose(): void {
    // no-op
  }
}
