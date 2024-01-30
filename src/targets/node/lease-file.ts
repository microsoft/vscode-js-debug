/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { randomBytes } from 'crypto';
import { promises as fs, readFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { IDisposable } from '../../common/events';

/**
 * File that stores a lease on the filesystem. Can be validated to ensure
 * that the file is still 'held' by someone.
 */
export class LeaseFile implements IDisposable {
  private static readonly updateInterval = 1000;
  private static readonly recencyDeadline = 2000;
  private file: Promise<fs.FileHandle>;
  private disposed = false;

  /**
   * Path of the callback file.
   */
  public readonly path = path.join(
    tmpdir(),
    `node-debug-callback-${randomBytes(8).toString('hex')}`,
  );

  /**
   * Update timer.
   */
  private updateInterval?: NodeJS.Timeout;

  constructor() {
    this.file = fs.open(this.path, 'w');
  }

  /**
   * Returns whether the given file path points to a valid lease.
   */
  public static isValid(file: string) {
    try {
      const contents = readFileSync(file);
      if (!contents.length) {
        return false;
      }

      return contents.readDoubleBE() > Date.now() - LeaseFile.recencyDeadline;
    } catch {
      return false;
    }
  }

  /**
   * Starts keeping the file up to date.
   */
  public async startTouchLoop() {
    await this.touch();
    if (!this.disposed) {
      this.updateInterval = setInterval(() => this.touch(), LeaseFile.updateInterval);
    }
  }

  /**
   * Updates the leased file.
   */
  public async touch(dateProvider = () => Date.now()) {
    const fd = await this.file;
    const buf = Buffer.alloc(8);
    buf.writeDoubleBE(dateProvider());
    await fd.write(buf, 0, buf.length, 0);
  }

  /**
   * Diposes of the callback file.
   */
  public async dispose() {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
    }

    try {
      const fd = await this.file;
      await fd.close();
      await fs.unlink(this.path);
    } catch {
      // ignored
    }
  }
}
