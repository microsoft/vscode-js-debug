/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { IProcessTelemetry } from './nodeLauncher';
import { ChildProcess } from 'child_process';
import { killTree } from './killTree';
import Dap from '../../dap/api';

export interface IProgram {
  readonly stopped: Promise<void>;

  /**
   * Callback given to the program after telemetry is queried.
   */
  gotTelemetery(telemetry: IProcessTelemetry): void;

  /**
   * Forcefully stops the program.
   */
  stop(): Promise<void>;
}

/**
 * Program created from a subprocess.
 */
export class SubprocessProgram implements IProgram {
  public readonly stopped: Promise<void>;

  constructor(private child: ChildProcess) {
    this.stopped = new Promise((resolve, reject) => {
      child.once('exit', resolve);
      child.once('error', reject);
    });
  }

  public gotTelemetery() {
    // no-op
  }

  public stop(): Promise<void> {
    killTree(this.child.pid);
    return this.stopped;
  }
}

/**
 * Program created from a subprocess.
 */
export class TerminalProcess implements IProgram {
  /**
   * How often to check and see if the process exited.
   */
  private static readonly terminationPollInterval = 1000;

  private didStop = false;
  private onStopped!: () => void;
  public readonly stopped = new Promise<void>(
    resolve =>
      (this.onStopped = () => {
        this.didStop = true;
        resolve();
      }),
  );
  private loop?: { timer: NodeJS.Timer; processId: number };

  constructor(private readonly terminalResult: Dap.RunInTerminalResult) {
    if (terminalResult.processId) {
      this.startPollLoop(terminalResult.processId);
    }
  }

  public gotTelemetery({ processId }: IProcessTelemetry) {
    this.startPollLoop(processId);
  }

  public stop(): Promise<void> {
    this.onStopped();

    if (!this.loop) {
      if (this.terminalResult.shellProcessId) {
        killTree(this.terminalResult.shellProcessId);
      }

      return Promise.resolve();
    }

    killTree(this.loop.processId);
    clearInterval(this.loop.timer);
    return this.stopped;
  }

  private startPollLoop(processId: number) {
    if (this.loop) {
      return;
    }

    if (this.didStop) {
      killTree(processId);
      return; // to avoid any races
    }

    const loop = {
      processId,
      timer: setInterval(() => {
        try {
          // kill with signal=0 just test for whether the proc is alive. It throws if not.
          process.kill(processId, 0);
        } catch {
          clearInterval(loop.timer);
          this.onStopped();
        }
      }, TerminalProcess.terminationPollInterval),
    };

    this.loop = loop;
  }
}
