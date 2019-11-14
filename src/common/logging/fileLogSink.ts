/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { WriteStream, createWriteStream, mkdirSync } from 'fs';
import { ILogSink, ILogItem } from '.';
import Dap from '../../dap/api';
import { dirname } from 'path';

const replacer = (_key: string, value: unknown): any => {
  if (value instanceof Error) {
    return {
      message: value.message,
      stack: value.stack,
      ...value,
    };
  }

  return value;
};

const writingFiles = new Set<String>();

/**
 * A log sink that writes to a file.
 */
export class FileLogSink implements ILogSink {
  private stream?: WriteStream;

  constructor(private readonly file: string, private readonly dap: Dap.Api) {
    try {
      mkdirSync(dirname(file), { recursive: true });
    } catch {
      // already exists
    }

    this.stream = writingFiles.has(file) ? undefined : createWriteStream(file, { flags: 'a' });
    writingFiles.add(file);
  }

  /**
   * @inheritdoc
   */
  public async setup() {
    this.dap.output({
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
      writingFiles.delete(this.file);
    }
  }

  /**
   * @inheritdoc
   */
  public write(item: ILogItem<any>): void {
    if (this.stream) {
      this.stream.write(JSON.stringify(item, replacer) + '\n');
    }
  }
}
