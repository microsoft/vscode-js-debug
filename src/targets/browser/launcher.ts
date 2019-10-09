// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as http from 'http';
import * as https from 'https';
import * as URL from 'url';
import * as childProcess from 'child_process';
import * as readline from 'readline';
import CdpConnection from '../../cdp/connection';
import { PipeTransport, WebSocketTransport } from '../../cdp/transport';
import { Readable, Writable } from 'stream';
import { EnvironmentVars } from '../../common/environmentVars';
import { RawTelemetryReporterToDap, RawTelemetryReporter } from '../../telemetry/telemetryReporter';

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

interface LaunchOptions {
  args?: ReadonlyArray<string>;
  dumpio?: boolean;
  cwd?: string;
  env?: EnvironmentVars;
  ignoreDefaultArgs?: boolean;
  pipe?: boolean;
  timeout?: number;
  userDataDir?: string;
}

export async function launch(
  executablePath: string,
  rawTelemetryReporter: RawTelemetryReporter,
  options: LaunchOptions | undefined = {},
): Promise<CdpConnection> {
  const {
    args = [],
    dumpio = false,
    cwd = process.cwd(),
    env = EnvironmentVars.empty,
    ignoreDefaultArgs = false,
    pipe = false,
    timeout = 30000,
  } = options;

  const browserArguments: string[] = [];
  if (!ignoreDefaultArgs) browserArguments.push(...defaultArgs(options));
  else if (Array.isArray(ignoreDefaultArgs))
    browserArguments.push(
      ...defaultArgs(options).filter(arg => ignoreDefaultArgs.indexOf(arg) === -1),
    );
  else browserArguments.push(...args);

  if (!browserArguments.some(argument => argument.startsWith('--remote-debugging-')))
    browserArguments.push(pipe ? '--remote-debugging-pipe' : '--remote-debugging-port=0');

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
  let browserClosed = false;

  if (browserProcess.pid === undefined) {
    killBrowser();
    throw new Error('Unable to launch the executable');
  }

  if (dumpio) {
    browserProcess.stderr!.on('data', data => console.warn(data.toString()));
    browserProcess.stdout!.on('data', data => console.warn(data.toString()));
  }

  process.on('exit', killBrowser);
  try {
    if (!usePipe) {
      const browserWSEndpoint = await waitForWSEndpoint(browserProcess, timeout);
      const transport = await WebSocketTransport.create(browserWSEndpoint);
      return new CdpConnection(transport, rawTelemetryReporter);
    } else {
      const stdio = (browserProcess.stdio as unknown) as [
        Writable,
        Readable,
        Readable,
        Writable,
        Readable,
      ];
      const transport = new PipeTransport(stdio[3], stdio[4]);
      return new CdpConnection(transport, rawTelemetryReporter);
    }
  } catch (e) {
    killBrowser();
    throw e;
  }

  // This method has to be sync to be used as 'exit' event handler.
  function killBrowser() {
    process.removeListener('exit', killBrowser);
    if (browserProcess.pid && !browserProcess.killed && !browserClosed) {
      // Force kill browser.
      try {
        if (process.platform === 'win32')
          childProcess.execSync(`taskkill /pid ${browserProcess.pid} /T /F`);
        else process.kill(-browserProcess.pid, 'SIGKILL');
      } catch (e) {
        // the process might have already stopped
      }
    }
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

export async function attach(options: AttachOptions, rawTelemetryReporter: RawTelemetryReporterToDap): Promise<CdpConnection> {
  const { browserWSEndpoint, browserURL } = options;

  if (browserWSEndpoint) {
    const connectionTransport = await WebSocketTransport.create(browserWSEndpoint);
    return new CdpConnection(connectionTransport, rawTelemetryReporter);
  } else if (browserURL) {
    const connectionURL = await getWSEndpoint(browserURL);
    const connectionTransport = await WebSocketTransport.create(connectionURL);
    return new CdpConnection(connectionTransport, rawTelemetryReporter);
  }
  throw new Error('Either browserURL or browserWSEndpoint needs to be specified');
}

function waitForWSEndpoint(
  browserProcess: childProcess.ChildProcess,
  timeout: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: browserProcess.stderr! });
    let stderr = '';
    const onClose = () => onDone();
    const onExit = () => onDone();
    const onError = error => onDone(error);

    rl.on('line', onLine);
    rl.on('close', onClose);
    browserProcess.on('exit', onExit);
    browserProcess.on('error', onError);

    const timeoutId = timeout ? setTimeout(onTimeout, timeout) : 0;

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

    function onTimeout() {
      cleanup();
      reject(new Error(`Timed out after ${timeout} ms while trying to connect to the browser!`));
    }

    function onLine(line: string) {
      stderr += line + '\n';
      const match = line.match(/^DevTools listening on (ws:\/\/.*)$/);
      if (!match) return;
      cleanup();
      resolve(match[1]);
    }

    function cleanup() {
      if (timeoutId) clearTimeout(timeoutId);
      rl.removeListener('line', onLine);
      rl.removeListener('close', onClose);
      browserProcess.removeListener('exit', onExit);
      browserProcess.removeListener('error', onError);
    }
  });
}

export async function getWSEndpoint(browserURL: string): Promise<string> {
  const jsonVersion = await fetchJson<{ webSocketDebuggerUrl?: string }>(URL.resolve(browserURL, '/json/version'));
  if (jsonVersion.webSocketDebuggerUrl) {
    return jsonVersion.webSocketDebuggerUrl;
  }

  // Chrome its top-level debugg on /json/version, while Node does not.
  // Request both and return whichever one got us a string.
  const jsonList = await fetchJson<{ webSocketDebuggerUrl: string }[]>(URL.resolve(browserURL, '/json/list'));
  if (jsonList.length) {
    return jsonList[0].webSocketDebuggerUrl;
  }

  throw new Error('Could not find any debuggable target');
}

async function fetchJson<T>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const protocolRequest = url.startsWith('https')
      ? https.request.bind(https)
      : http.request.bind(http);
    const requestOptions = Object.assign(URL.parse(url), { method: 'GET' });
    const request = protocolRequest(requestOptions, (res: http.IncomingMessage) => {
      let data = '';
      if (res.statusCode !== 200) {
        // Consume response data to free up memory.
        res.resume();
        reject(new Error('HTTP ' + res.statusCode));
        return;
      }

      res.setEncoding('utf8');
      res.on('data', chunk => (data += chunk));
      res.on('end', () => resolve(JSON.parse(data)));
    });

    request.on('error', reject!);
    request.end();
  });
}
