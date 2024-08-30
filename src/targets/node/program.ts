/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { ChildProcess } from 'child_process';
import { ILogger } from '../../common/logging';
import { KillBehavior } from '../../configuration';
import Dap from '../../dap/api';
import { IStopMetadata } from '../targets';
import { killTree } from './killTree';
import { IProcessTelemetry } from './nodeLauncherBase';
import { WatchDog } from './watchdogSpawn';

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
 * A Program that wraps two other programs. "Stops" once either of the programs
 * stop. If one program stops, the other is also stopped automatically.
 */
export class CombinedProgram implements IProgram {
  public readonly stopped = Promise.race([
    this.a.stopped.then(async r => (await this.b.stop()) && r),
    this.b.stopped.then(async r => (await this.a.stop()) && r),
  ]);

  constructor(private readonly a: IProgram, private readonly b: IProgram) {}

  public gotTelemetery(telemetry: IProcessTelemetry) {
    this.a.gotTelemetery(telemetry);
    this.b.gotTelemetery(telemetry);
  }

  public async stop(): Promise<IStopMetadata> {
    const r = await Promise.all([this.a.stop(), this.b.stop()]);
    return r[0];
  }
}

/**
 * Program created from a subprocess.
 */
export class SubprocessProgram implements IProgram {
  public readonly stopped: Promise<IStopMetadata>;
  private killed = false;

  constructor(
    private readonly child: ChildProcess,
    private readonly logger: ILogger,
    private readonly killBehavior: KillBehavior,
  ) {
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
    killTree(this.child.pid as number, this.logger, this.killBehavior);
    return this.stopped;
  }
}

/**
 * A no-op program that never stops until stop() is called. Currently, we use
 * this for VS Code launches as we have no way to forcefully close those sssions.
 */
export class StubProgram implements IProgram {
  public readonly stopped: Promise<IStopMetadata>;
  protected stopDefer!: (data: IStopMetadata) => void;
  protected telemetry?: IProcessTelemetry;

  constructor() {
    this.stopped = new Promise(resolve => (this.stopDefer = resolve));
  }

  public gotTelemetery(telemetry: IProcessTelemetry) {
    this.telemetry = telemetry;
  }

  public stop() {
    this.stopDefer({ code: 0, killed: true });
    return this.stopped;
  }
}

/**
 * Wrapper for the watchdog program.
 */
export class WatchDogProgram extends StubProgram {
  constructor(private readonly wd: WatchDog) {
    super();
    wd.onEnd(data => {
      this.stopDefer(data);
      this.wd.dispose();
    });
  }

  public stop() {
    this.wd.dispose();
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

  /**
   * How often to check and see if the process exited after we send a close signal.
   */
  private static readonly killConfirmInterval = 200;

  private didStop = false;
  private onStopped!: (killed: boolean) => void;
  public readonly stopped = new Promise<IStopMetadata>(
    resolve => (this.onStopped = killed => {
      this.didStop = true;
      resolve({ code: 0, killed });
    }),
  );
  private loop?: { timer: NodeJS.Timeout; processId: number };

  constructor(
    private readonly terminalResult: Dap.RunInTerminalResult,
    private readonly logger: ILogger,
    private readonly killBehavior: KillBehavior,
  ) {
    if (terminalResult.processId) {
      this.startPollLoop(terminalResult.processId);
    }
  }

  public gotTelemetery({ processId }: IProcessTelemetry) {
    if (this.didStop) {
      killTree(processId, this.logger, this.killBehavior);
      return; // to avoid any races
    }

    if (!this.loop) {
      this.startPollLoop(processId);
    }
  }

  public stop(): Promise<IStopMetadata> {
    if (this.didStop) {
      return this.stopped;
    }
    this.didStop = true;

    // If we're already polling some process ID, kill it and accelerate polling
    // so we can confirm it's dead quickly.
    if (this.loop) {
      killTree(this.loop.processId, this.logger, this.killBehavior);
      this.startPollLoop(this.loop.processId, TerminalProcess.killConfirmInterval);
    } else if (this.terminalResult.shellProcessId) {
      // If we had a shell process ID, well, that's good enough.
      killTree(this.terminalResult.shellProcessId, this.logger, this.killBehavior);
      this.startPollLoop(this.terminalResult.shellProcessId, TerminalProcess.killConfirmInterval);
    } else {
      // Otherwise, we can't do anything. Pretend like we did.
      this.onStopped(true);
    }

    return this.stopped;
  }

  private startPollLoop(processId: number, interval = TerminalProcess.terminationPollInterval) {
    if (this.loop) {
      clearInterval(this.loop.timer);
    }

    const loop = {
      processId,
      timer: setInterval(() => {
        if (!isProcessAlive(processId)) {
          clearInterval(loop.timer);
          this.onStopped(true);
        }
      }, interval),
    };

    this.loop = loop;
  }
}

function isProcessAlive(processId: number) {
  try {
    // kill with signal=0 just test for whether the proc is alive. It throws if not.
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
}
