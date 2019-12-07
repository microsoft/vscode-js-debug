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

const enum FileStreamState {
  Inactive,
  Open,
  Closing,
}

type FileStreamData =
  | { state: FileStreamState.Inactive }
  | { state: FileStreamState.Open; stream: WriteStream }
  | { state: FileStreamState.Closing; queue: string[] };

class FileStream {
  private s: FileStreamData = { state: FileStreamState.Inactive };

  constructor(private readonly path: string) {}

  public close() {
    if (this.s.state !== FileStreamState.Open) {
      return;
    }

    const next: FileStreamData = { state: FileStreamState.Closing, queue: [] };
    this.s.stream.end(() => {
      if (!next.queue.length) {
        this.s = { state: FileStreamState.Inactive };
        return;
      }

      const stream = createWriteStream(this.path);
      this.s = { state: FileStreamState.Open, stream };
      next.queue.forEach(d => stream.write(d));
    });
  }

  public write(data: string) {
    switch (this.s.state) {
      case FileStreamState.Inactive:
        try {
          mkdirSync(dirname(this.path), { recursive: true });
        } catch {
          // already exists
        }

        this.s = { state: FileStreamState.Open, stream: createWriteStream(this.path) };
      // fall through
      case FileStreamState.Open:
        this.s.stream.write(data);
        break;
      case FileStreamState.Closing:
        this.s.queue.push(data);
        break;
      default:
        throw new Error(`Unknown state ${this.s}`);
    }
  }
}

/**
 * A log sink that writes to a file.
 */
export class FileLogSink implements ILogSink {
  private static readonly streams = new Map<string, FileStream>();
  private stream?: FileStream;

  constructor(private readonly file: string, private readonly dap: Dap.Api) {
    let stream = FileLogSink.streams.get(file);
    if (!stream) {
      stream = new FileStream(file);
      FileLogSink.streams.set(file, stream);
    }

    this.stream = stream;
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
      this.stream.close();
      this.stream = undefined;
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
