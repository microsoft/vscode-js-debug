/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import type { Event } from 'vscode';
import Cdp from '../../cdp/api';
import { IDisposable } from '../../common/disposable';
import { Thread } from '../threads';
import { IConsoleMessage } from './consoleMessage';

export * from './exceptionMessage';
export * from './queryObjectsMessage';

export const IConsole = Symbol('IConsole');

export interface IConsole extends IDisposable {
  /**
   * Fires when the output queue is drained.
   */
  readonly onDrained: Event<void>;

  /**
   * Gets the current length of the output queue.
   */
  readonly length: number;

  /**
   * Translates and sends the event to the underlying DAP connection.
   */
  dispatch(thread: Thread, event: Cdp.Runtime.ConsoleAPICalledEvent): void;

  /**
   * Parses the event to a console message. Returns undefined if the message
   * cannot be parsed or should not be sent to the client.
   */
  parse(event: Cdp.Runtime.ConsoleAPICalledEvent): IConsoleMessage | undefined;

  /**
   * Schedules the message, or promise of a message, to be written to the console.
   */
  enqueue(thread: Thread, message: IConsoleMessage): void;
}
