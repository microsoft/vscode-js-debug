/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import DapConnection, { Message } from './connection';
import { EventEmitter, IDisposable } from '../common/events';
import { HighResolutionTime } from '../utils/performance';
import { TelemetryReporter } from '../telemetry/telemetryReporter';
import { assert } from '../common/logging/logger';

/**
 * An extension of the DAP connection class which publishes all messages which are received
 */
export class MessageEmitterConnection extends DapConnection {
  private readonly _messageEventEmitter = new EventEmitter<Message>();
  public readonly onMessage = this._messageEventEmitter.event;
  public readonly initialized = new EventEmitter<TelemetryReporter>();

  public get telemetryReporter(): TelemetryReporter | undefined {
    return this._telemetryReporter;
  }

  async _onMessage(msg: Message, receivedTime: HighResolutionTime) {
    msg.__receivedTime = receivedTime;
    this._messageEventEmitter.fire(msg);
  }

  public init(inStream: NodeJS.ReadableStream, outStream: NodeJS.WritableStream) {
    super.init(inStream, outStream);

    if (assert(this._telemetryReporter, 'Expected telemetry reporter to have been set')) {
      this.initialized.fire(this._telemetryReporter);
    }
  }
}

/**
 * An extension of the DAP connection class which subscribes to a MessageEmitterConnection,
 * subscribes to that message stream, and filters based on sessionId to subscribe only to messages relevant
 * to a child session.
 */
export class ChildConnection extends DapConnection {
  private _messageSubscription: IDisposable;

  constructor(
    private readonly parentConnection: MessageEmitterConnection,
    private readonly sessionId: string | undefined,
  ) {
    super();
    this._telemetryReporter = parentConnection.telemetryReporter;

    parentConnection.initialized.event(telemetryReporter => {
      this._telemetryReporter = telemetryReporter;
    });

    this._messageSubscription = parentConnection.onMessage(msg => {
      if (msg.sessionId === this.sessionId) {
        super._onMessage(msg, msg.__receivedTime || [0, 0]);
      }
    });

    this._ready(this._createApi());
  }

  _send(msg: Message) {
    msg.sessionId = this.sessionId;
    this.parentConnection._send(msg);
  }

  dispose() {
    this._messageSubscription.dispose();
  }
}
