/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { Event } from 'vscode';
import { IDisposable } from '../common/disposable';

export interface ITransport extends IDisposable {
  readonly onMessage: Event<[/* contents */ string, /* receivedTime */ bigint]>;
  readonly onEnd: Event<void>;

  /**
   * Sends a serialized message over the transport.
   */
  send(message: string): void;
}
