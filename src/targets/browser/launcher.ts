// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as http from 'http';
import * as https from 'https';
import * as URL from 'url';
import * as childProcess from 'child_process';
import * as readline from 'readline';
import CdpConnection from '../../cdp/connection';
import { PipeTransport, WebSocketTransport, Transport } from '../../cdp/transport';
import { Readable, Writable } from 'stream';
import { EnvironmentVars } from '../../common/environmentVars';
import { RawTelemetryReporterToDap, RawTelemetryReporter } from '../../telemetry/telemetryReporter';
import { CancellationToken } from 'vscode';
import { TaskCancelledError } from '../../common/cancellation';
import { IDisposable } from '../../common/disposable';
import { delay } from '../../common/promiseUtil';
import { killTree } from '../node/killTree';

const DEFAULT_ARGS = [
  '--disable-background-networking',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-breakpad',
  '--disable-client-side-phishing-detection',
  '--disable-default-apps',
  '--disable-dev-shm-usage',
  '--disable-extensions',
  '--disable-renderer-backgrounding',
  '--disable-sync',
  '--metrics-recording-only',
  '--no-first-run',
];

const noop = () => undefined;

interface LaunchOptions {
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
  args?: ReadonlyArray<string>;
  dumpio?: boolean;
  cwd?: string;
  env?: EnvironmentVars;
  ignoreDefaultArgs?: boolean;
  connection?: 'pipe' | number; // pipe or port number
  userDataDir?: string;
}

const suggestedPortArg = '--remote-debugging-';

const findSuggestedPort = (args: ReadonlyArray<string>): number | undefined => {
  const arg = args.find(a => a.startsWith(suggestedPortArg));
  return arg ? Number(arg.slice(suggestedPortArg.length)) : undefined;
};

export interface ILaunchResult {
  cdp: CdpConnection;
  process: childProcess.ChildProcess;
}

export async function launch(
  executablePath: string,
  rawTelemetryReporter: RawTelemetryReporter,
  cancellationToken: CancellationToken,
  options: LaunchOptions | undefined = {},
): Promise<ILaunchResult> {
  const {
    onStderr = noop,
    onStdout = noop,
    args = [],
    dumpio = false,
    cwd = process.cwd(),
    env = EnvironmentVars.empty,
    ignoreDefaultArgs = false,
    connection = 'pipe',
  } = options;

  const browserArguments: string[] = [];
  if (!ignoreDefaultArgs) {
    browserArguments.push(...defaultArgs(options));
  } else if (Array.isArray(ignoreDefaultArgs)) {
    browserArguments.push(...defaultArgs(options).filter(arg => !ignoreDefaultArgs.includes(arg)));
  } else {
    browserArguments.push(...args);
  }

  let suggestedPort = findSuggestedPort(args);
  if (suggestedPort === undefined) {
    if (connection === 'pipe') {
      browserArguments.push('--remote-debugging-pipe');
    } else {
      suggestedPort = connection;
      browserArguments.push(`--remote-debugging-port=${connection}`);
    }
  }

  const usePipe = browserArguments.includes('--remote-debugging-pipe');
  let stdio: ('pipe' | 'ignore')[] = ['pipe', 'pipe', 'pipe'];
  if (usePipe) {
    if (dumpio) stdio = ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'];
    else stdio = ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'];
  }
  const browserProcess = childProcess.spawn(executablePath, browserArguments, {
    // On non-windows platforms, `detached: false` makes child process a leader of a new
    // process group, making it possible to kill child process tree with `.kill(-pid)` command.
    // @see https://nodejs.org/api/child_process.html#child_process_options_detached
    detached: process.platform !== 'win32',
    env: env.defined(),
    cwd,
    stdio,
  });

  if (browserProcess.pid === undefined) {
    throw new Error('Unable to launch the executable');
  }

  if (dumpio) {
    browserProcess.stderr!.on('data', d => onStderr(d.toString()));
    browserProcess.stdout!.on('data', d => onStdout(d.toString()));
  }

  const exitListener = () => killTree(browserProcess.pid);
  process.on('exit', exitListener);
  browserProcess.on('exit', () => process.removeListener('exit', exitListener));

  try {
    let transport: Transport;
    if (usePipe) {
      transport = new PipeTransport(
        browserProcess.stdio[3] as Writable,
        browserProcess.stdio[4] as Readable,
      );
    } else if (suggestedPort === undefined || suggestedPort === 0) {
      const endpoint = await waitForWSEndpoint(browserProcess, cancellationToken);
      transport = await WebSocketTransport.create(endpoint, cancellationToken);
    } else {
      const endpoint = await waitForDebuggerServerOnPort(suggestedPort, cancellationToken);
      transport = await WebSocketTransport.create(endpoint, cancellationToken);
    }

    return { cdp: new CdpConnection(transport, rawTelemetryReporter), process: browserProcess };
  } catch (e) {
    exitListener();
    throw e;
  }
}

function defaultArgs(options: LaunchOptions | undefined = {}): Array<string> {
  const { args = [], userDataDir = null } = options;
  const browserArguments = [...DEFAULT_ARGS];
  if (userDataDir) browserArguments.push(`--user-data-dir=${userDataDir}`);
  browserArguments.push(...args);
  if (args.every(arg => arg.startsWith('-'))) browserArguments.push('about:blank');
  return browserArguments;
}

interface AttachOptions {
  browserURL?: string;
  browserWSEndpoint?: string;
}

export async function attach(
  options: AttachOptions,
  cancellationToken: CancellationToken,
  rawTelemetryReporter: RawTelemetryReporterToDap,
): Promise<CdpConnection> {
  const { browserWSEndpoint, browserURL } = options;

  if (browserWSEndpoint) {
    const connectionTransport = await WebSocketTransport.create(
      browserWSEndpoint,
      cancellationToken,
    );
    return new CdpConnection(connectionTransport, rawTelemetryReporter);
  } else if (browserURL) {
    const connectionURL = await getWSEndpoint(browserURL, cancellationToken);
    const connectionTransport = await WebSocketTransport.create(connectionURL, cancellationToken);
    return new CdpConnection(connectionTransport, rawTelemetryReporter);
  }
  throw new Error('Either browserURL or browserWSEndpoint needs to be specified');
}

/**
 * Polls for the debug server on the port, until we get a server or
 * cancellation is requested.
 */
async function waitForDebuggerServerOnPort(port: number, ct: CancellationToken) {
  while (!ct.isCancellationRequested) {
    try {
      return await getWSEndpoint(`http://localhost:${port}`, ct);
    } catch (_e) {
      await delay(50);
    }
  }

  throw new TaskCancelledError('Lookup cancelled');
}

function waitForWSEndpoint(
  browserProcess: childProcess.ChildProcess,
  cancellationToken: CancellationToken,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: browserProcess.stderr! });
    let stderr = '';
    const onClose = () => onDone();
    const onExit = () => onDone();
    const onError = (error: Error) => onDone(error);

    rl.on('line', onLine);
    rl.on('close', onClose);
    browserProcess.on('exit', onExit);
    browserProcess.on('error', onError);

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
      browserProcess.removeListener('exit', onExit);
      browserProcess.removeListener('error', onError);
    }
  });
}

export async function getWSEndpoint(
  browserURL: string,
  cancellationToken: CancellationToken,
): Promise<string> {
  const jsonVersion = await fetchJson<{ webSocketDebuggerUrl?: string }>(
    URL.resolve(browserURL, '/json/version'),
    cancellationToken,
  );
  if (jsonVersion.webSocketDebuggerUrl) {
    return jsonVersion.webSocketDebuggerUrl;
  }

  // Chrome its top-level debugg on /json/version, while Node does not.
  // Request both and return whichever one got us a string.
  const jsonList = await fetchJson<{ webSocketDebuggerUrl: string }[]>(
    URL.resolve(browserURL, '/json/list'),
    cancellationToken,
  );
  if (jsonList.length) {
    return jsonList[0].webSocketDebuggerUrl;
  }

  throw new Error('Could not find any debuggable target');
}

async function fetchJson<T>(url: string, cancellationToken: CancellationToken): Promise<T> {
  const disposables: IDisposable[] = [];

  return new Promise<T>((resolve, reject) => {
    const protocolRequest = url.startsWith('https')
      ? https.request.bind(https)
      : http.request.bind(http);

    const request = protocolRequest(url, res => {
      disposables.push(cancellationToken.onCancellationRequested(() => res.destroy()));

      let data = '';
      if (res.statusCode !== 200) {
        res.resume(); // Consume response data to free up memory.
        reject(new Error('HTTP ' + res.statusCode));
        return;
      }

      res.setEncoding('utf8');
      res.on('data', chunk => (data += chunk));
      res.on('end', () => resolve(JSON.parse(data)));
    });

    disposables.push(
      cancellationToken.onCancellationRequested(() => {
        request.destroy();
        reject(new TaskCancelledError(`Cancelled GET ${url}`));
      }),
    );

    request.on('error', reject);
    request.end();
  }).finally(() => disposables.forEach(d => d.dispose()));
}
