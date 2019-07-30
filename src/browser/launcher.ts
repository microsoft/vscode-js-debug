// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as http from 'http';
import * as https from 'https';
import * as URL from 'url';
import * as childProcess from 'child_process';
import * as readline from 'readline';
import * as eventUtils from '../utils/eventUtils';
import CdpConnection from '../cdp/connection';
import { PipeTransport, WebSocketTransport } from '../cdp/transport';
import { Readable, Writable } from 'stream';

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
  args?: string[];
  dumpio?: boolean;
  env?: Object;
  ignoreDefaultArgs?: boolean;
  pipe?: boolean;
  timeout?: number;
  userDataDir?: string;
}

export async function launch(executablePath: string, options: LaunchOptions | undefined = {}): Promise<CdpConnection> {
  const {
    args = [],
    dumpio = false,
    env = process.env,
    ignoreDefaultArgs = false,
    pipe = false,
    timeout = 30000,
  } = options;

  const browserArguments: string[] = [];
  if (!ignoreDefaultArgs)
    browserArguments.push(...defaultArgs(options));
  else if (Array.isArray(ignoreDefaultArgs))
    browserArguments.push(...defaultArgs(options).filter(arg => ignoreDefaultArgs.indexOf(arg) === -1));
  else
    browserArguments.push(...args);

  if (!browserArguments.some(argument => argument.startsWith('--remote-debugging-')))
    browserArguments.push(pipe ? '--remote-debugging-pipe' : '--remote-debugging-port=0');

  const usePipe = browserArguments.includes('--remote-debugging-pipe');
  const stdio: Array<string> = usePipe ? ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'];
  const browserProcess = childProcess.spawn(
    executablePath,
    browserArguments,
    {
      // On non-windows platforms, `detached: false` makes child process a leader of a new
      // process group, making it possible to kill child process tree with `.kill(-pid)` command.
      // @see https://nodejs.org/api/child_process.html#child_process_options_detached
      detached: process.platform !== 'win32',
      env,
      stdio
    }
  );

  if (dumpio) {
    browserProcess.stderr.pipe(process.stderr);
    browserProcess.stdout.pipe(process.stdout);
  }

  let browserClosed = false;
  const listeners = [eventUtils.addEventListener(process, 'exit', killBrowser)];
  try {
    if (!usePipe) {
      const browserWSEndpoint = await waitForWSEndpoint(browserProcess, timeout);
      const transport = await WebSocketTransport.create(browserWSEndpoint);
      return new CdpConnection(transport);
    } else {
      const stdio = browserProcess.stdio as unknown as [Writable, Readable, Readable, Writable, Readable];
      const transport = new PipeTransport(stdio[3], stdio[4]);
      return new CdpConnection(transport);
    }
  } catch (e) {
    killBrowser();
    throw e;
  }

  // This method has to be sync to be used as 'exit' event handler.
  function killBrowser() {
    eventUtils.removeEventListeners(listeners);
    if (browserProcess.pid && !browserProcess.killed && !browserClosed) {
      // Force kill browser.
      try {
        if (process.platform === 'win32')
          childProcess.execSync(`taskkill /pid ${browserProcess.pid} /T /F`);
        else
          process.kill(-browserProcess.pid, 'SIGKILL');
      } catch (e) {
        // the process might have already stopped
      }
    }
  }
}

function defaultArgs(options: LaunchOptions | undefined = {}): Array<string> {
  const {
    args = [],
    userDataDir = null
  } = options;
  const browserArguments = [...DEFAULT_ARGS];
  if (userDataDir)
    browserArguments.push(`--user-data-dir=${userDataDir}`);
  if (args.every(arg => arg.startsWith('-')))
    browserArguments.push('about:blank');
  browserArguments.push(...args);
  return browserArguments;
}

interface AttachOptions {
  browserURL?: string;
  browserWSEndpoint?: string;
}

export async function attach(options: AttachOptions): Promise<CdpConnection> {
  const {
    browserWSEndpoint,
    browserURL,
  } = options;

  if (browserWSEndpoint) {
    const connectionTransport = await WebSocketTransport.create(browserWSEndpoint);
    return new CdpConnection(connectionTransport);
  } else if (browserURL) {
    const connectionURL = await getWSEndpoint(browserURL);
    const connectionTransport = await WebSocketTransport.create(connectionURL);
    return new CdpConnection(connectionTransport);
  }
  throw new Error('Either browserURL or browserWSEndpoint needs to be specified');
}

function waitForWSEndpoint(browserProcess: childProcess.ChildProcess, timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: browserProcess.stderr });
    let stderr = '';
    const listeners = [
      eventUtils.addEventListener(rl, 'line', onLine),
      eventUtils.addEventListener(rl, 'close', () => onClose()),
      eventUtils.addEventListener(browserProcess, 'exit', () => onClose()),
      eventUtils.addEventListener(browserProcess, 'error', error => onClose(error))
    ];
    const timeoutId = timeout ? setTimeout(onTimeout, timeout) : 0;

    function onClose(error?: Error) {
      cleanup();
      reject(new Error([
        'Failed to launch browser!' + (error ? ' ' + error.message : ''),
        stderr,
        '',
        'TROUBLESHOOTING: https://github.com/GoogleChrome/puppeteer/blob/master/docs/troubleshooting.md',
        '',
      ].join('\n')));
    }

    function onTimeout() {
      cleanup();
      reject(new Error(`Timed out after ${timeout} ms while trying to connect to the browser!`));
    }

    function onLine(line: string) {
      stderr += line + '\n';
      const match = line.match(/^DevTools listening on (ws:\/\/.*)$/);
      if (!match)
        return;
      cleanup();
      resolve(match[1]);
    }

    function cleanup() {
      if (timeoutId)
        clearTimeout(timeoutId);
      eventUtils.removeEventListeners(listeners);
    }
  });
}

function getWSEndpoint(browserURL: string): Promise<string> {
  let resolve: (o: string) => void;
  let reject: (e: Error) => void;
  const promise: Promise<string> = new Promise((res, rej) => { resolve = res; reject = rej; });

  const endpointURL = URL.resolve(browserURL, '/json/version');
  const protocolRequest = endpointURL.startsWith('https') ? https.request.bind(https) : http.request.bind(http);
  const requestOptions = Object.assign(URL.parse(endpointURL), { method: 'GET' });
  const request = protocolRequest.request(requestOptions, res => {
    let data = '';
    if (res.statusCode !== 200) {
      // Consume response data to free up memory.
      res.resume();
      reject(new Error('HTTP ' + res.statusCode));
      return;
    }
    res.setEncoding('utf8');
    res.on('data', chunk => data += chunk);
    res.on('end', () => resolve(JSON.parse(data).webSocketDebuggerUrl));
  });

  request.on('error', reject!);
  request.end();

  return promise.catch(e => {
    e.message = `Failed to fetch browser webSocket url from ${endpointURL}: ` + e.message;
    throw e;
  });
}
