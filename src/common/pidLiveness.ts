/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { IDisposable } from './disposable';

/**
 * Utility to poll a PID for liveness and notify when it exits.
 */
export class PidLiveness implements IDisposable {
  private timer?: NodeJS.Timeout;

  constructor(
    public readonly pid: number,
    private readonly onExit: (killed: boolean) => void,
    pollInterval: number,
  ) {
    this.updateInterval(pollInterval);
  }

  public dispose() {
    clearInterval(this.timer);
  }

  public updateInterval(interval = 200) {
    if (this.timer) {
      clearInterval(this.timer);
    }

    this.timer = setInterval(() => {
      if (!isProcessAlive(this.pid)) {
        this.onExit(true);
        this.dispose();
      }
    }, interval);
  }
}

function isProcessAlive(processId: number) {
  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
}
