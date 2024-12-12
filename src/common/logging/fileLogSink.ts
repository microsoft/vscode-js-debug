/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { createWriteStream, mkdirSync } from 'fs';
import { dirname } from 'path';
import { Writable } from 'stream';
import Dap from '../../dap/api';
import { ILogItem, ILogSink } from '.';

const replacer = (_key: string, value: unknown): unknown => {
  if (value instanceof Error) {
    return {
      message: value.message,
      stack: value.stack,
    };
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  return value;
};

/**
 * A log sink that writes to a file.
 */
export class FileLogSink implements ILogSink {
  private stream?: Writable;

  constructor(private readonly file: string, private readonly dap?: Dap.Api) {
    try {
      mkdirSync(dirname(file), { recursive: true });
    } catch {
      // already exists
    }

    this.stream = createWriteStream(file);
  }

  /**
   * @inheritdoc
   */
  public async setup() {
    this.dap?.output({
      category: 'console',
      output: `Verbose logs are written to:\n${this.file}\n`,
    });
  }

  /**
   * @inheritdoc
   */
  public dispose() {
    if (this.stream) {
      this.stream.end();
      this.stream = undefined;
    }
  }

  /**
   * @inheritdoc
   */
  public write(item: ILogItem<unknown>): void {
    if (this.stream) {
      this.stream.write(JSON.stringify(item, replacer) + '\n');
    }
  }
}
