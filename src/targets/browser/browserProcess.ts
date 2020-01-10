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
  readonly pid: number | undefined;
  readonly stderr: NodeJS.ReadableStream;
  readonly stdout: NodeJS.ReadableStream;
  removeListener(eventName: 'exit', onExit: (code: number) => void): void;
  removeListener(eventName: 'error', onError: (error: Error) => void): void;
  on(eventName: string, listener: Function): void;
}

export class NonTrackedBrowserProcess implements IBrowserProcess {
  public readonly pid = undefined;

  public get stdio(): stdioType {
    throw new Error('Operation not supported when browser launched unelevated');
  }

  public readonly stderr: NodeJS.ReadableStream = new stream.Readable(); // Empty stream
  public readonly stdout: NodeJS.ReadableStream = new stream.Readable(); // Empty stream

  on(eventName: string, listener: Function): void {
    // We ignore all events
  }
  removeListener(eventName: any, listener: any) {
    // We ignore all events
  }
}
