/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { inject, injectable } from 'inversify';
import Cdp from '../../cdp/api';
import { assertNever } from '../../common/objUtils';
import Dap from '../../dap/api';
import { IDapApi } from '../../dap/connection';
import { IShutdownParticipants, ShutdownOrder } from '../../ui/shutdownParticipants';
import { Thread } from '../threads';
import { IConsole } from '.';
import { ClearMessage, EndGroupMessage, IConsoleMessage } from './consoleMessage';
import { ReservationQueue } from './reservationQueue';
import {
  AssertMessage,
  ErrorMessage,
  LogMessage,
  StartGroupMessage,
  TableMessage,
  TraceMessage,
  WarningMessage,
} from './textualMessage';

const duplicateNodeJsLogFunctions = new Set(['group', 'assert', 'count']);

@injectable()
export class Console implements IConsole {
  private isDirty = false;

  private readonly queue = new ReservationQueue<Dap.OutputEventParams>(events => {
    for (const event of events) {
      this.dap.output(event);
    }
  });

  /**
   * Fires when the queue is drained.
   */
  public readonly onDrained = this.queue.onDrained;

  /**
   * Gets the current length of the queue.
   */
  public get length() {
    return this.queue.length;
  }

  constructor(
    @inject(IDapApi) private readonly dap: Dap.Api,
    @inject(IShutdownParticipants) shutdown: IShutdownParticipants,
  ) {
    shutdown.register(ShutdownOrder.ExecutionContexts, async final => {
      if (this.length) {
        await new Promise(r => this.onDrained(r));
      }
      if (final) {
        this.dispose();
      }
    });
  }

  /**
   * @inheritdoc
   */
  public dispose() {
    this.queue.dispose();
  }

  /**
   * @inheritdoc
   */
  public dispatch(thread: Thread, event: Cdp.Runtime.ConsoleAPICalledEvent) {
    const parsed = this.parse(event);
    if (parsed) {
      this.enqueue(thread, parsed);
    }
  }

  /**
   * @inheritdoc
   */
  public enqueue(thread: Thread, message: IConsoleMessage) {
    if (!(message instanceof ClearMessage)) {
      this.isDirty = true;
    } else if (this.isDirty) {
      this.isDirty = false;
    } else {
      return;
    }

    this.queue.enqueue(message.toDap(thread));
  }

  /**
   * @inheritdoc
   */
  public parse(event: Cdp.Runtime.ConsoleAPICalledEvent): IConsoleMessage | undefined {
    if (event.type === 'log') {
      // Ignore the duplicate group events that Node.js can emit:
      // See: https://github.com/nodejs/node/issues/31973
      const firstFrame = event.stackTrace?.callFrames[0];
      if (
        firstFrame
        && firstFrame.url === 'internal/console/constructor.js'
        && duplicateNodeJsLogFunctions.has(firstFrame.functionName)
      ) {
        return;
      }
    }

    switch (event.type) {
      case 'clear':
        return new ClearMessage();
      case 'endGroup':
        return new EndGroupMessage();
      case 'assert':
        return new AssertMessage(event);
      case 'table':
        return new TableMessage(event);
      case 'startGroup':
      case 'startGroupCollapsed':
        return new StartGroupMessage(event);
      case 'debug':
      case 'log':
      case 'info':
        return new LogMessage(event);
      case 'trace':
        return new TraceMessage(event);
      case 'error':
        return new ErrorMessage(event);
      case 'warning':
        return new WarningMessage(event);
      case 'dir':
      case 'dirxml':
        return new LogMessage(event); // a normal object inspection
      case 'count':
        return new LogMessage(event); // contents are like a normal log
      case 'profile':
      case 'profileEnd':
        return new LogMessage(event); // non-standard events, not implemented in Chrome it seems
      case 'timeEnd':
        return new LogMessage(event); // contents are like a normal log
      default:
        try {
          assertNever(event.type, 'unknown console message type');
        } catch {
          // ignore
        }
    }
  }
}
