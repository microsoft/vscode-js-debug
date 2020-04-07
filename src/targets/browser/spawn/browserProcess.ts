/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { Event, CancellationToken } from 'vscode';
import { ChildProcessWithoutNullStreams } from 'child_process';
import { retryGetWSEndpoint } from './endpoints';
import { constructInspectorWSUri } from '../constructInspectorWSUri';
import { EventEmitter } from '../../../common/events';
import { Writable, Readable } from 'stream';
import * as readline from 'readline';
import { ILogger } from '../../../common/logging';
import { TaskCancelledError } from '../../../common/cancellation';
import { DisposableList } from '../../../common/disposable';
import { killTree } from '../../node/killTree';
import { delay } from '../../../common/promiseUtil';
import { ITransport } from '../../../cdp/transport';
import { WebSocketTransport } from '../../../cdp/webSocketTransport';
import { RawPipeTransport } from '../../../cdp/rawPipeTransport';

interface ITransportOptions {
  connection: 'pipe' | number;
  inspectUri?: string;
  url?: string | null;
}

/**
 * A Browser processed launched through some mechanism.
 */
export interface IBrowserProcess {
  /**
   * Standard error stream, if available.
   */
  readonly stderr?: NodeJS.ReadableStream;

  /**
   * Standard output stream, if available.
   */
  readonly stdout?: NodeJS.ReadableStream;

  /**
   * Emitter that fires when the process exits.
   */
  readonly onExit: Event<number>;

  /**
   * Emitter that fires if the process errors.
   */
  readonly onError: Event<Error>;

  /**
   * Gets the CDP transport for the process.
   */
  transport(options: ITransportOptions, cancellation: CancellationToken): Promise<ITransport>;

  /**
   * Terminates the process;
   */
  kill(): void;
}

const inspectWsConnection = async (
  process: IBrowserProcess,
  options: ITransportOptions,
  cancellationToken: CancellationToken,
) => {
  const endpoint =
    options.connection === 0
      ? await waitForWSEndpoint(process, cancellationToken)
      : await retryGetWSEndpoint(`http://localhost:${options.connection}`, cancellationToken);

  const inspectWs = options.inspectUri
    ? constructInspectorWSUri(options.inspectUri, options.url, endpoint)
    : endpoint;

  while (true) {
    try {
      return await WebSocketTransport.create(inspectWs, cancellationToken);
    } catch (e) {
      if (cancellationToken.isCancellationRequested) {
        throw e;
      }

      await delay(200);
    }
  }
};

export class NonTrackedBrowserProcess implements IBrowserProcess {
  public readonly pid = undefined;
  public readonly onExit = new EventEmitter<number>().event;
  public readonly onError = new EventEmitter<Error>().event;

  /**
   * @inheritdoc
   */
  public async transport(
    options: ITransportOptions,
    cancellationToken: CancellationToken,
  ): Promise<ITransport> {
    return inspectWsConnection(this, options, cancellationToken);
  }

  /**
   * @inheritdoc
   */
  public kill() {
    // noop
  }
}

/**
 * Browser process
 */
export class ChildProcessBrowserProcess implements IBrowserProcess {
  public readonly pid = undefined;

  private readonly exitEmitter = new EventEmitter<number>();
  public readonly onExit = this.exitEmitter.event;

  private readonly errorEmitter = new EventEmitter<Error>();
  public readonly onError = this.errorEmitter.event;

  constructor(
    private readonly cp: ChildProcessWithoutNullStreams,
    private readonly logger: ILogger,
  ) {
    cp.on('exit', code => this.exitEmitter.fire(code || 0));
    cp.on('error', error => this.errorEmitter.fire(error));
  }

  public get stderr() {
    return this.cp.stderr;
  }

  public get stdio() {
    return this.cp.stdio;
  }

  /**
   * @inheritdoc
   */
  public async transport(
    options: ITransportOptions,
    cancellationToken: CancellationToken,
  ): Promise<ITransport> {
    if (options.connection === 'pipe') {
      return new RawPipeTransport(
        this.logger,
        this.cp.stdio[3] as Writable,
        this.cp.stdio[4] as Readable,
      );
    }

    return inspectWsConnection(this, options, cancellationToken);
  }

  /**
   * @inheritdoc
   */
  public kill() {
    killTree(this.cp.pid, this.logger);
  }
}

function waitForWSEndpoint(
  browserProcess: IBrowserProcess,
  cancellationToken: CancellationToken,
): Promise<string> {
  if (!browserProcess.stderr) {
    throw new Error('Cannot wait for a websocket for a target that lacks stderr');
  }

  return new Promise((resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const rl = readline.createInterface({ input: browserProcess.stderr! });
    let stderr = '';
    const onClose = () => onDone();

    rl.on('line', onLine);
    rl.on('close', onClose);

    const disposable = new DisposableList([
      browserProcess.onExit(() => onDone()),
      browserProcess.onError(onDone),
    ]);

    const timeout = cancellationToken.onCancellationRequested(() => {
      cleanup();
      reject(
        new TaskCancelledError(
          `Timed out after ${timeout} ms while trying to connect to the browser!`,
        ),
      );
    });

    function onDone(error?: Error) {
      cleanup();
      reject(
        new Error(
          [
            'Failed to launch browser!' + (error ? ' ' + error.message : ''),
            stderr,
            '',
            'TROUBLESHOOTING: https://github.com/GoogleChrome/puppeteer/blob/master/docs/troubleshooting.md',
            '',
          ].join('\n'),
        ),
      );
    }

    function onLine(line: string) {
      stderr += line + '\n';
      const match = line.match(/^DevTools listening on (ws:\/\/.*)$/);
      if (!match) return;
      cleanup();
      resolve(match[1]);
    }

    function cleanup() {
      timeout.dispose();
      rl.removeListener('line', onLine);
      rl.removeListener('close', onClose);
      disposable.dispose();
    }
  });
}
