/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { DisposableList } from '../common/disposable';
import { EventEmitter } from '../common/events';
import { HrTime } from '../common/hrnow';
import Cdp from './api';
import { ITransport } from './transport';

/**
 * Transport used for debugging node worker threads over the NodeTarget API.
 */
export class WorkerTransport implements ITransport {
  private readonly onMessageEmitter = new EventEmitter<[string, HrTime]>();
  private readonly onEndEmitter = new EventEmitter<void>();
  private readonly disposables = new DisposableList();

  public readonly onMessage = this.onMessageEmitter.event;
  public readonly onEnd = this.onEndEmitter.event;

  constructor(private readonly sessionId: string, private readonly sink: Cdp.Api) {
    this.disposables.push(
      sink.NodeWorker.on('detachedFromWorker', evt => {
        if (evt.sessionId === sessionId) {
          this.onEndEmitter.fire();
          this.dispose();
        }
      }),
      sink.NodeWorker.on('receivedMessageFromWorker', evt => {
        if (evt.sessionId === sessionId) {
          this.onMessageEmitter.fire([evt.message, new HrTime()]);
        }
      }),
    );
  }

  send(message: string): void {
    this.sink.NodeWorker.sendMessageToWorker({ message, sessionId: this.sessionId });
  }

  dispose(): void {
    if (!this.disposables.isDisposed) {
      this.disposables.dispose();
      this.onEndEmitter.fire();
    }
  }
}
