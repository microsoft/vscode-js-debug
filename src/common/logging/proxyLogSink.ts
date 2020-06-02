/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { ILogSink, ILogItem, ILogger } from '.';

/*
 * A log sink that writes information to another logger.
 */
export class ProxyLogSink implements ILogSink {
  constructor(private logger: ILogger | undefined) {}

  /**
   * @inheritdoc
   */
  public async setup() {
    // no-op
  }

  /**
   * @inheritdoc
   */
  public dispose() {
    this.logger = undefined;
  }

  /**
   * @inheritdoc
   */
  public write(item: ILogItem<unknown>): void {
    this.logger?.log(item);
  }
}
