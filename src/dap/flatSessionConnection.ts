/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import DapConnection, { Message } from './connection';
import { EventEmitter, IDisposable } from '../common/events';
import { TelemetryReporter } from '../telemetry/telemetryReporter';
import { ILogger } from '../common/logging';

/**
 * An extension of the DAP connection class which publishes all messages which are received
 */
export class MessageEmitterConnection extends DapConnection {
  private readonly _messageEventEmitter = new EventEmitter<Message>();
  public readonly onMessage = this._messageEventEmitter.event;
  public readonly initialized = new EventEmitter<TelemetryReporter>();

  async _onMessage(msg: Message, receivedTime: bigint) {
    msg.__receivedTime = receivedTime;
    this._messageEventEmitter.fire(msg);
  }

  public init(inStream: NodeJS.ReadableStream, outStream: NodeJS.WritableStream) {
    super.init(inStream, outStream);
    this.initialized.fire(this.telemetryReporter);
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
    logger: ILogger,
    telemetryReporter: TelemetryReporter,
    private readonly parentConnection: MessageEmitterConnection,
    private readonly sessionId: string | undefined,
  ) {
    super(telemetryReporter, logger);

    this._messageSubscription = parentConnection.onMessage(msg => {
      if (msg.sessionId === this.sessionId) {
        super._onMessage(msg, msg.__receivedTime || BigInt(0));
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
