// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import DapConnection, { Message } from './connection';
import { EventEmitter, Disposable } from '../common/events';

/**
 * An extension of the DAP connection class which publishes all messages which are received
 */
export class MessageEmitterConnection extends DapConnection {

  private readonly _messageEventEmitter = new EventEmitter<Message>();
  public readonly onMessage = this._messageEventEmitter.event;
  async _onMessage(msg: Message) {
    this._messageEventEmitter.fire(msg);
  }
}

/**
 * An extension of the DAP connection class which subscribes to a MessageEmitterConnection,
 * subscribes to that message stream, and filters based on sessionId to subscribe only to messages relevant
 * to a child session.
 */
export class ChildConnection extends DapConnection {
  private _messageSubscription: Disposable;

  constructor(private readonly parentConnection: MessageEmitterConnection, private readonly sessionId: string|undefined) {
    super();
    this._messageSubscription = parentConnection.onMessage(msg => {
      if(msg.sessionId === this.sessionId) {
        super._onMessage(msg);
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
