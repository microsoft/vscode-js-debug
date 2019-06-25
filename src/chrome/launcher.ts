// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as http from 'http';
import * as https from 'https';
import * as URL from 'url';
import * as childProcess from 'child_process';
import * as readline from 'readline';
import * as utils from '../utils';
import CdpConnection from '../cdp/connection';
import {PipeTransport, WebSocketTransport} from '../cdp/transport';
import {Readable, Writable} from 'stream';

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

  const chromeArguments: string[] = [];
  if (!ignoreDefaultArgs)
    chromeArguments.push(...defaultArgs(options));
  else if (Array.isArray(ignoreDefaultArgs))
    chromeArguments.push(...defaultArgs(options).filter(arg => ignoreDefaultArgs.indexOf(arg) === -1));
  else
    chromeArguments.push(...args);

  if (!chromeArguments.some(argument => argument.startsWith('--remote-debugging-')))
    chromeArguments.push(pipe ? '--remote-debugging-pipe' : '--remote-debugging-port=0');

  const usePipe = chromeArguments.includes('--remote-debugging-pipe');
  const stdio: Array<string> = usePipe ? ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'];
  const chromeProcess = childProcess.spawn(
    executablePath,
    chromeArguments,
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
    chromeProcess.stderr.pipe(process.stderr);
    chromeProcess.stdout.pipe(process.stdout);
  }

  let chromeClosed = false;
  const listeners = [utils.addEventListener(process, 'exit', killChrome)];
  try {
    if (!usePipe) {
      const browserWSEndpoint = await waitForWSEndpoint(chromeProcess, timeout);
      const transport = await WebSocketTransport.create(browserWSEndpoint);
      return new CdpConnection(transport);
    } else {
      const stdio = chromeProcess.stdio as unknown as [Writable, Readable, Readable, Writable, Readable];
      const transport = new PipeTransport(stdio[3], stdio[4]);
      return new CdpConnection(transport);
    }
  } catch (e) {
    killChrome();
    throw e;
  }

  // This method has to be sync to be used as 'exit' event handler.
  function killChrome() {
    utils.removeEventListeners(listeners);
    if (chromeProcess.pid && !chromeProcess.killed && !chromeClosed) {
      // Force kill chrome.
      try {
        if (process.platform === 'win32')
          childProcess.execSync(`taskkill /pid ${chromeProcess.pid} /T /F`);
        else
          process.kill(-chromeProcess.pid, 'SIGKILL');
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
  const chromeArguments = [...DEFAULT_ARGS];
  if (userDataDir)
    chromeArguments.push(`--user-data-dir=${userDataDir}`);
  if (args.every(arg => arg.startsWith('-')))
    chromeArguments.push('about:blank');
  chromeArguments.push(...args);
  return chromeArguments;
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

function waitForWSEndpoint(chromeProcess: childProcess.ChildProcess, timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: chromeProcess.stderr });
    let stderr = '';
    const listeners = [
      utils.addEventListener(rl, 'line', onLine),
      utils.addEventListener(rl, 'close', () => onClose()),
      utils.addEventListener(chromeProcess, 'exit', () => onClose()),
      utils.addEventListener(chromeProcess, 'error', error => onClose(error))
    ];
    const timeoutId = timeout ? setTimeout(onTimeout, timeout) : 0;

    function onClose(error?: Error) {
      cleanup();
      reject(new Error([
        'Failed to launch chrome!' + (error ? ' ' + error.message : ''),
        stderr,
        '',
        'TROUBLESHOOTING: https://github.com/GoogleChrome/puppeteer/blob/master/docs/troubleshooting.md',
        '',
      ].join('\n')));
    }

    function onTimeout() {
      cleanup();
      reject(new Error(`Timed out after ${timeout} ms while trying to connect to Chrome!`));
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
      utils.removeEventListeners(listeners);
    }
  });
}

function getWSEndpoint(browserURL: string): Promise<string> {
  let resolve: (o: string) => void;
  let reject: (e: Error) => void
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

  request.on('error', reject);
  request.end();

  return promise.catch(e => {
    e.message = `Failed to fetch browser webSocket url from ${endpointURL}: ` + e.message;
    throw e;
  });
}
