/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as http from 'http';
import * as https from 'https';
import * as URL from 'url';
import * as childProcess from 'child_process';
import * as readline from 'readline';
import CdpConnection from '../../cdp/connection';
import { PipeTransport, WebSocketTransport, ITransport } from '../../cdp/transport';
import { Readable, Writable } from 'stream';
import { EnvironmentVars } from '../../common/environmentVars';
import {
  RawTelemetryReporterToDap,
  IRawTelemetryReporter,
} from '../../telemetry/telemetryReporter';
import { CancellationToken } from 'vscode';
import { TaskCancelledError } from '../../common/cancellation';
import { IDisposable } from '../../common/disposable';
import { delay } from '../../common/promiseUtil';
import { killTree } from '../node/killTree';
import { launchUnelevatedChrome } from './unelevatedChome';
import { IBrowserProcess, BrowserProcessByPid } from './browserProcess';
import Dap from '../../dap/api';
import { IDapInitializeParamsWithExtensions } from './browserLauncher';

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

interface ILaunchOptions {
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
  args?: ReadonlyArray<string>;
  dumpio?: boolean;
  hasUserNavigation?: boolean;
  cwd?: string;
  env?: EnvironmentVars;
  ignoreDefaultArgs?: boolean;
  connection?: 'pipe' | number; // pipe or port number
  userDataDir?: string;
  launchUnelevatedFlag?: boolean;
}

const suggestedPortArg = '--remote-debugging-';

const findSuggestedPort = (args: ReadonlyArray<string>): number | undefined => {
  const arg = args.find(a => a.startsWith(suggestedPortArg));
  if (!arg) {
    return undefined;
  }

  const match = /[0-9]+/.exec(arg);
  return match ? Number(match[0]) : 0;
};

export interface ILaunchResult {
  cdp: CdpConnection;
  process: IBrowserProcess;
}

export async function launch(
  dap: Dap.Api,
  executablePath: string,
  rawTelemetryReporter: IRawTelemetryReporter,
  clientCapabilities: IDapInitializeParamsWithExtensions,
  cancellationToken: CancellationToken,
  options: ILaunchOptions | undefined = {},
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

  let suggestedPort = findSuggestedPort(args);
  if (suggestedPort === undefined) {
    if (connection === 'pipe') {
      browserArguments.push('--remote-debugging-pipe');
    } else {
      suggestedPort = connection;
      browserArguments.push(`--remote-debugging-port=${connection}`);
    }
  }

  if (!ignoreDefaultArgs) {
    browserArguments.push(...defaultArgs(options));
  } else if (Array.isArray(ignoreDefaultArgs)) {
    browserArguments.push(...defaultArgs(options).filter(arg => !ignoreDefaultArgs.includes(arg)));
  } else {
    browserArguments.push(...args);
  }

  const usePipe = browserArguments.includes('--remote-debugging-pipe');
  let stdio: ('pipe' | 'ignore')[] = ['pipe', 'pipe', 'pipe'];
  if (usePipe) {
    if (dumpio) stdio = ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'];
    else stdio = ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'];
  }

  let browserProcess: IBrowserProcess;
  const launchUnelevated = !!(
    clientCapabilities.supportsLaunchUnelevatedProcessRequest && options.launchUnelevatedFlag
  );
  if (launchUnelevated && !usePipe && suggestedPort && suggestedPort !== 0) {
    const pid = await launchUnelevatedChrome(dap, executablePath, browserArguments);
    browserProcess = new BrowserProcessByPid(pid);
  } else {
    browserProcess = childProcess.spawn(executablePath, browserArguments, {
      // On non-windows platforms, `detached: false` makes child process a leader of a new
      // process group, making it possible to kill child process tree with `.kill(-pid)` command.
      // @see https://nodejs.org/api/child_process.html#child_process_options_detached
      detached: process.platform !== 'win32',
      env: env.defined(),
      cwd,
      stdio,
    }) as childProcess.ChildProcessWithoutNullStreams;
  }

  if (browserProcess.pid === undefined) {
    throw new Error('Unable to launch the executable');
  }

  if (dumpio) {
    browserProcess.stderr.on('data', d => onStderr(d.toString()));
    browserProcess.stdout.on('data', d => onStdout(d.toString()));
  }

  const exitListener = () => killTree(browserProcess.pid);
  process.on('exit', exitListener);
  browserProcess.on('exit', () => process.removeListener('exit', exitListener));

  try {
    let transport: ITransport;
    if (usePipe) {
      transport = new PipeTransport(
        browserProcess.stdio[3] as Writable,
        browserProcess.stdio[4] as Readable,
      );
    } else if (suggestedPort === undefined || suggestedPort === 0) {
      const endpoint = await waitForWSEndpoint(browserProcess, cancellationToken);
      transport = await WebSocketTransport.create(endpoint, cancellationToken);
    } else {
      const endpoint = await retryGetWSEndpoint(
        `http://localhost:${suggestedPort}`,
        cancellationToken,
      );
      transport = await WebSocketTransport.create(endpoint, cancellationToken);
    }

    return { cdp: new CdpConnection(transport, rawTelemetryReporter), process: browserProcess };
  } catch (e) {
    exitListener();
    throw e;
  }
}

function defaultArgs(options: ILaunchOptions | undefined = {}): Array<string> {
  const { args = [], userDataDir = null } = options;
  const browserArguments = [...DEFAULT_ARGS];
  if (userDataDir) browserArguments.push(`--user-data-dir=${userDataDir}`);
  browserArguments.push(...args);
  if (args.every(arg => arg.startsWith('-')) && options.hasUserNavigation) {
    browserArguments.push('about:blank');
  }

  return browserArguments;
}

interface IAttachOptions {
  browserURL?: string;
  browserWSEndpoint?: string;
}

export async function attach(
  options: IAttachOptions,
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
    const connectionURL = await retryGetWSEndpoint(browserURL, cancellationToken);
    const connectionTransport = await WebSocketTransport.create(connectionURL, cancellationToken);
    return new CdpConnection(connectionTransport, rawTelemetryReporter);
  }
  throw new Error('Either browserURL or browserWSEndpoint needs to be specified');
}

function waitForWSEndpoint(
  browserProcess: IBrowserProcess,
  cancellationToken: CancellationToken,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: browserProcess.stderr });
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

/**
 * Returns the debugger websocket URL a process listening at the given address.
 * @param browserURL -- Address like `http://localhost:1234`
 * @param cancellationToken -- Optional cancellation for this operation
 */
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

/**
 * Attempts to retrieve the debugger websocket URL for a process listening
 * at the given address, retrying until available.
 * @param browserURL -- Address like `http://localhost:1234`
 * @param cancellationToken -- Optional cancellation for this operation
 */
export async function retryGetWSEndpoint(
  browserURL: string,
  cancellationToken: CancellationToken,
): Promise<string> {
  try {
    return await getWSEndpoint(browserURL, cancellationToken);
  } catch (e) {
    if (cancellationToken.isCancellationRequested) {
      throw new Error(`Could not connect to debug target at ${browserURL}: ${e.message}`);
    }

    await delay(200);
    return retryGetWSEndpoint(browserURL, cancellationToken);
  }
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
