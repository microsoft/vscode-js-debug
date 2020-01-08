/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
import * as stream from 'stream';

type stdioType = [
  NodeJS.WritableStream, // stdin
  NodeJS.ReadableStream, // stdout
  NodeJS.ReadableStream, // stderr
  NodeJS.ReadableStream | NodeJS.WritableStream | null | undefined, // extra, no modification
  NodeJS.ReadableStream | NodeJS.WritableStream | null | undefined, // extra, no modification
];

export interface IBrowserProcess {
  readonly stdio: stdioType;
  readonly pid: number;
  readonly stderr: NodeJS.ReadableStream;
  readonly stdout: NodeJS.ReadableStream;
  removeListener(eventName: 'exit', onExit: (code: number) => void): void;
  removeListener(eventName: 'error', onError: (error: Error) => void): void;
  on(eventName: string, listener: Function): void;
}

export class BrowserProcessByPid implements IBrowserProcess {
  public constructor(public readonly pid: number) {}

  // TODO: Figure out how to use a WeakSet here so we don't have a memory leak (At the moment we don't use it because it can't be iterated)
  private static instancesToPoll = new Set<BrowserProcessByPid>();

  private static pollInterval: NodeJS.Timeout | null = null;
  private exitListeners = new Set<Function>();

  public get stdio(): stdioType {
    throw new Error('Operation not supported when browser launched unelevated');
  }

  public readonly stderr: NodeJS.ReadableStream = new stream.Readable(); // Empty stream
  public readonly stdout: NodeJS.ReadableStream = new stream.Readable(); // Empty stream

  on(eventName: string, listener: Function): void {
    if (eventName === 'exit') {
      this.exitListeners.add(listener);
      if (this.exitListeners.size === 1) {
        BrowserProcessByPid.instancesToPoll.add(this);
        if (BrowserProcessByPid.pollInterval === null) {
          BrowserProcessByPid.pollInterval = setInterval(
            () => BrowserProcessByPid.pollAllInstances(),
            500,
          );
        }
      }
    }
  }

  removeListener(eventName: 'exit', onExit: (code: number) => void): void;
  removeListener(eventName: 'error', onError: (error: Error) => void): void;
  removeListener(eventName: string, listener: () => void): void;
  removeListener(eventName: any, listener: any) {
    if (eventName === 'exit') {
      this.exitListeners.delete(listener);
      if (this.exitListeners.size === 0) {
        BrowserProcessByPid.instancesToPoll.delete(this);
      }
    }
  }

  private static pollAllInstances(): void {
    let count = 0;
    for (const instance of [...this.instancesToPoll]) {
      ++count;
      if (!isProcessStillAlive(instance)) {
        instance.exitListeners.forEach(listener => listener());
        this.instancesToPoll.delete(instance);
      }
    }

    if (count === 0 && this.pollInterval !== null) {
      clearInterval(this.pollInterval);
    }
  }
}

function isProcessStillAlive(instance: BrowserProcessByPid): boolean {
  try {
    process.kill(instance.pid, 0);
    return true;
  } catch (exception) {
    return exception.code !== 'ESRCH';
  }
}
