/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as path from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { IDisposable } from '../../common/events';
import { unlinkSync, readFileSync, writeFileSync } from 'fs';

/**
 * File that stores a lease on the filesystem. Can be validated to ensure
 * that the file is still 'held' by someone.
 */
export class LeaseFile implements IDisposable {
  private static readonly updateInterval = 1000;
  private static readonly recencyDeadline = 2000;

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
  private updateInterval: NodeJS.Timer;

  constructor() {
    this.touch();
    this.updateInterval = setInterval(() => this.touch(), LeaseFile.updateInterval);
  }

  /**
   * Returns whether the given file path points to a valid lease.
   */
  public static isValid(file: string) {
    try {
      return Number(readFileSync(file, 'utf-8')) > Date.now() - LeaseFile.recencyDeadline;
    } catch {
      return false;
    }
  }

  /**
   * Updates the leased file.
   */
  public touch() {
    writeFileSync(this.path, String(Date.now()));
  }

  /**
   * Diposes of the callback file.
   */
  public dispose() {
    clearInterval(this.updateInterval);
    try {
      unlinkSync(this.path);
    } catch {
      // ignored
    }
  }
}
