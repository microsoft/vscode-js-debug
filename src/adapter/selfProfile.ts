/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { Session } from 'inspector';
import { promises as fs } from 'fs';

/**
 * Small class used to profile the extension itself. Used for collecting
 * information in the VS error reporter.
 */
export class SelfProfile {
  private session = new Session();

  constructor(private readonly file: string) {
    this.session.connect();
  }

  /**
   * Starts the profile.
   */
  public async start() {
    try {
      await this.post('Profiler.enable');
    } catch {
      // already enabled
    }

    await this.post('Profiler.start');
  }

  /**
   * Stop the profile.
   */
  public async stop() {
    const { profile } = await this.post<{ profile: object }>('Profiler.stop');
    await fs.writeFile(this.file, JSON.stringify(profile));
  }

  public dispose() {
    this.session.disconnect();
  }

  private post<R = unknown>(method: string, params?: {}) {
    return new Promise<R>((resolve, reject) =>
      this.session.post(method, params, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result as R);
        }
      }),
    );
  }
}
