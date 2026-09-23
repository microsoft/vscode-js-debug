/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as fs from 'fs';
import { IDisposable } from '../../common/events';
import { ILogger, LogTag } from '../../common/logging';

/**
 * Debounce window between the last observed file change and the reload, so a
 * build emitting many files triggers a single reload once it settles.
 */
const RELOAD_DEBOUNCE_MS = 400;

/**
 * Watches an unpacked extension's directory and invokes `reload` when its
 * contents change. Used for launched browsers where the extension can be
 * re-installed over CDP (`Extensions.loadUnpacked`), which restarts its
 * service worker and re-attaches the debugger via the normal target flow.
 */
export class ExtensionAutoReloader implements IDisposable {
  private watcher?: fs.FSWatcher;
  private timer?: NodeJS.Timeout;
  private reloading = false;
  private pending = false;
  private disposed = false;

  constructor(
    extensionPath: string,
    private readonly reload: () => Promise<void>,
    private readonly logger: ILogger,
  ) {
    try {
      this.watcher = fs.watch(extensionPath, { recursive: true }, () => this.schedule());
    } catch {
      try {
        // recursive watches are unavailable on some platforms; a top-level
        // watch still catches typical bundler output rewrites
        this.watcher = fs.watch(extensionPath, () => this.schedule());
      } catch (e) {
        this.logger.warn(
          LogTag.RuntimeTarget,
          'Could not watch the extension directory for changes; auto-reload disabled',
          { extensionPath, error: e },
        );
      }
    }
  }

  private schedule() {
    if (this.disposed) {
      return;
    }

    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => this.run(), RELOAD_DEBOUNCE_MS);
  }

  private async run() {
    if (this.disposed) {
      return;
    }

    // a change arriving while a reload is in flight schedules one trailing
    // reload rather than stacking them
    if (this.reloading) {
      this.pending = true;
      return;
    }

    this.reloading = true;
    try {
      await this.reload();
    } catch (e) {
      this.logger.warn(LogTag.RuntimeTarget, 'Error reloading extension', e);
    } finally {
      this.reloading = false;
      if (this.pending && !this.disposed) {
        this.pending = false;
        this.schedule();
      }
    }
  }

  public dispose() {
    this.disposed = true;
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.watcher?.close();
  }
}
