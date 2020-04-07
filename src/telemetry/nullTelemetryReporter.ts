/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { ITelemetryReporter } from './telemetryReporter';
import { EventEmitter } from '../common/events';
import { injectable } from 'inversify';

@injectable()
export class NullTelemetryReporter implements ITelemetryReporter {
  private readonly flushEmitter = new EventEmitter<void>();
  public readonly onFlush = this.flushEmitter.event;

  /**
   * @inheritdoc
   */
  public report() {
    // no-op
  }

  /**
   * @inheritdoc
   */
  public reportOperation() {
    // no-op
  }

  /**
   * @inheritdoc
   */
  public attachDap() {
    // no-op
  }

  /**
   * @inheritdoc
   */
  public flush() {
    this.flushEmitter.fire();
  }

  public dispose() {
    // no-op
  }
}
