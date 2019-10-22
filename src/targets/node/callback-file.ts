import * as path from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { Disposable } from '../../common/events';
import { unlinkSync, existsSync, readFileSync } from 'fs';

/**
 * File written by the bootloader containing some process information.
 */
export class CallbackFile<T> implements Disposable {
  private static readonly pollInterval = 200;

  /**
   * Path of the callback file.
   */
  public readonly path = path.join(
    tmpdir(),
    `node-debug-callback-${randomBytes(8).toString('hex')}`,
  );

  private disposed = false;
  private readPromise?: Promise<T | undefined>;

  /**
   * Reads the file, returnings its contants after they're written, or returns
   * undefined if the file was disposed of before the read completed.
   */
  public read(pollInterval = CallbackFile.pollInterval) {
    if (this.readPromise) {
      return this.readPromise;
    }

    this.readPromise = new Promise<T>((resolve, reject) => {
      const interval = setInterval(() => {
        if (this.disposed) {
          clearInterval(interval);
          resolve(undefined);
          return;
        }

        if (!existsSync(this.path)) {
          return;
        }

        try {
          resolve(JSON.parse(readFileSync(this.path, 'utf-8')));
        } catch (e) {
          reject(e);
        }

        clearInterval(interval);
      }, pollInterval);
    });

    return this.readPromise;
  }

  /**
   * Diposes of the callback file.
   */
  public dispose() {
    this.disposed = true;
    try {
      unlinkSync(this.path);
    } catch {
      // ignored
    }
  }
}
