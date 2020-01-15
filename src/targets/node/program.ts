/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { ChildProcess } from 'child_process';
import { killTree } from './killTree';
import Dap from '../../dap/api';
import { IStopMetadata } from '../targets';
import { IProcessTelemetry } from './nodeLauncherBase';

export interface IProgram {
  readonly stopped: Promise<IStopMetadata>;

  /**
   * Callback given to the program after telemetry is queried.
   */
  gotTelemetery(telemetry: IProcessTelemetry): void;

  /**
   * Forcefully stops the program.
   */
  stop(): Promise<IStopMetadata>;
}

/**
 * Program created from a subprocess.
 */
export class SubprocessProgram implements IProgram {
  public readonly stopped: Promise<IStopMetadata>;
  private killed = false;

  constructor(private readonly child: ChildProcess) {
    this.stopped = new Promise((resolve, reject) => {
      child.once('exit', code => resolve({ killed: this.killed, code: code || 0 }));
      child.once('error', error => reject({ killed: this.killed, code: 1, error }));
    });
  }

  public gotTelemetery() {
    // no-op
  }

  public stop(): Promise<IStopMetadata> {
    this.killed = true;
    killTree(this.child.pid);
    return this.stopped;
  }
}

/**
 * A no-op program that never stops until stop() is called. Currently, we use
 * this for VS Code launches as we have no way to forcefully close those sssions.
 */
export class StubProgram implements IProgram {
  public readonly stopped: Promise<IStopMetadata>;
  private stopDefer!: (data: IStopMetadata) => void;

  constructor() {
    this.stopped = new Promise(resolve => (this.stopDefer = resolve));
  }

  public gotTelemetery() {
    // no-op
  }

  public stop() {
    this.stopDefer({ code: 0, killed: true });
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
  private onStopped!: (killed: boolean) => void;
  public readonly stopped = new Promise<IStopMetadata>(
    resolve =>
      (this.onStopped = killed => {
        this.didStop = true;
        resolve({ code: 0, killed });
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

  public stop(): Promise<IStopMetadata> {
    this.onStopped(false);

    if (!this.loop) {
      if (this.terminalResult.shellProcessId) {
        killTree(this.terminalResult.shellProcessId);
      }

      return Promise.resolve({ code: 0, killed: true });
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
        if (!IsProcessAlive(processId)) {
          clearInterval(loop.timer);
          this.onStopped(true);
        }
      }, TerminalProcess.terminationPollInterval),
    };

    this.loop = loop;
  }
}

function IsProcessAlive(processId: number) {
  try {
    // kill with signal=0 just test for whether the proc is alive. It throws if not.
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
}
