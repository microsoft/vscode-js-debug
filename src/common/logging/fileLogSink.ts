/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { WriteStream, createWriteStream, mkdirSync } from 'fs';
import { ILogSink, ILogItem } from '.';
import Dap from '../../dap/api';
import { dirname } from 'path';

/**
 * A log sink that writes to a file.
 */
export class FileLogSink implements ILogSink {
  private readonly stream: WriteStream;

  constructor(private readonly file: string, private readonly dap: Dap.Api) {
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
    this.dap.output({
      category: 'console',
      output: `Verbose logs are written to:\n${this.file}\n`,
    });
  }

  /**
   * @inheritdoc
   */
  public dispose() {
    this.stream.end();
  }

  /**
   * @inheritdoc
   */
  public write(item: ILogItem<any>): void {
    this.stream.write(JSON.stringify(item) + '\n');
  }
}
