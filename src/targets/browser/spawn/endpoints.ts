/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { promises as fs } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { CancellationToken } from 'vscode';
import { Response } from '../../../adapter/resourceProvider';
import { BasicResourceProvider } from '../../../adapter/resourceProvider/basicResourceProvider';
import { CancellationTokenSource } from '../../../common/cancellation';
import { ILogger, LogTag } from '../../../common/logging';
import { delay, some } from '../../../common/promiseUtil';
import { isLoopback } from '../../../common/urlUtils';

/**
 * Returns the debugger websocket URL a process listening at the given address.
 * @param browserURL -- Address like `http://localhost:1234`
 * @param cancellationToken -- Optional cancellation for this operation
 */
export async function getWSEndpoint(
  browserURL: string,
  cancellationToken: CancellationToken,
  logger: ILogger,
  isNode: boolean,
  remoteHostHeader?: string,
): Promise<string> {
  const provider = new BasicResourceProvider(fs);
  const [jsonVersion, jsonList] = await Promise.all([
    fetchJsonWithLocalhostFallback<{ webSocketDebuggerUrl?: string }>(
      provider,
      new URL('/json/version', browserURL),
      cancellationToken,
      remoteHostHeader,
    ),
    // Chrome publishes its top-level debugg on /json/version, while Node does not.
    // Request both and return whichever one got us a string. ONLY try this on
    // Node, since it'll cause a failure on browsers (vscode#123420)
    isNode
      ? fetchJsonWithLocalhostFallback<{ webSocketDebuggerUrl: string }[]>(
        provider,
        new URL('/json/list', browserURL),
        cancellationToken,
        remoteHostHeader,
      )
      : Promise.resolve(undefined),
  ]);

  if (!jsonVersion.ok) {
    logger.verbose(LogTag.RuntimeLaunch, 'Error looking up /json/version', jsonVersion);
  } else if (jsonVersion.body.webSocketDebuggerUrl) {
    const fixed = fixRemoteUrl(jsonVersion.url, jsonVersion.body.webSocketDebuggerUrl);
    logger.verbose(LogTag.RuntimeLaunch, 'Discovered target URL from /json/version', {
      url: jsonVersion.body.webSocketDebuggerUrl,
      fixed,
    });
    return fixed;
  }

  if (!jsonList) {
    // no-op
  } else if (!jsonList.ok) {
    logger.verbose(LogTag.RuntimeLaunch, 'Error looking up /json/list', jsonList);
  } else {
    const fixed = fixRemoteUrl(jsonList.url, jsonList.body[0].webSocketDebuggerUrl);
    logger.verbose(LogTag.RuntimeLaunch, 'Discovered target URL from /json/list', {
      url: jsonList.body[0].webSocketDebuggerUrl,
      fixed,
    });
    return fixed;
  }

  throw new Error('Could not find any debuggable target');
}

/**
 * On `localhost`, try both `127.0.0.1` and `localhost` since ipv6 interfaces
 * might mean they're not equivalent.
 *
 * See https://github.com/microsoft/vscode/issues/144315
 */
async function fetchJsonWithLocalhostFallback<T>(
  provider: BasicResourceProvider,
  url: URL,
  cancellationToken: CancellationToken,
  remoteHostHeader?: string,
): Promise<Response<T>> {
  if (url.hostname !== 'localhost') {
    return provider.fetchJson<T>(url.toString(), cancellationToken, {
      host: remoteHostHeader ?? 'localhost',
    });
  }

  url.hostname = '127.0.0.1';
  const urlA = url.toString();
  url.hostname = '[::1]';
  const urlB = url.toString();

  const cts = new CancellationTokenSource(cancellationToken);
  try {
    let lastResponse: Response<T>;
    const goodResponse = await some(
      [urlA, urlB].map(async url => {
        lastResponse = await provider.fetchJson<T>(url, cts.token);
        return lastResponse.ok && lastResponse;
      }),
    );

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return goodResponse || lastResponse!;
  } finally {
    cts.cancel();
  }
}

const makeRetryGetWSEndpoint = (isNode: boolean) =>
async (
  browserURL: string,
  cancellationToken: CancellationToken,
  logger: ILogger,
  remoteHostHeader?: string,
): Promise<string> => {
  while (true) {
    try {
      return await getWSEndpoint(browserURL, cancellationToken, logger, isNode, remoteHostHeader);
    } catch (e) {
      if (cancellationToken.isCancellationRequested) {
        throw new Error(`Could not connect to debug target at ${browserURL}: ${e.message}`);
      }

      await delay(200);
    }
  }
};

/**
 * Attempts to retrieve the debugger websocket URL for a Node process listening
 * at the given address, retrying until available.
 * @param browserURL -- Address like `http://localhost:1234`
 * @param cancellationToken -- Optional cancellation for this operation
 */
export const retryGetNodeEndpoint = makeRetryGetWSEndpoint(true);

/**
 * Attempts to retrieve the debugger websocket URL for a browser listening
 * at the given address, retrying until available.
 * @param browserURL -- Address like `http://localhost:1234`
 * @param cancellationToken -- Optional cancellation for this operation
 */
export const retryGetBrowserEndpoint = makeRetryGetWSEndpoint(false);

export async function findDevToolsActivePortEndpoint(
  address: string,
  port: number,
  userDataDir: string | undefined,
  logger: ILogger,
): Promise<string | undefined> {
  const directories = userDataDir !== undefined
    ? [userDataDir]
    : await isLoopback(address)
    ? defaultUserDataDirectories()
    : [];
  const endpoints = await Promise.all(
    directories.map(async directory => {
      const contents = await fs.readFile(join(directory, 'DevToolsActivePort'), 'utf8').catch(() =>
        undefined
      );
      if (!contents) {
        return undefined;
      }

      const [filePort, wsPath] = contents.split('\n').map(line => line.trim());
      if (filePort !== String(port) || !wsPath) {
        return undefined;
      }

      const url = `ws://${address}:${port}${wsPath}`;
      logger.verbose(LogTag.RuntimeLaunch, 'Discovered target URL from DevToolsActivePort', {
        directory,
        url,
      });
      return url;
    }),
  );

  return endpoints.find(endpoint => endpoint !== undefined);
}

function defaultUserDataDirectories(): string[] {
  if (process.platform === 'darwin') {
    return [
      'Google/Chrome',
      'Google/Chrome Beta',
      'Google/Chrome Dev',
      'Google/Chrome Canary',
      'Chromium',
      'Microsoft Edge',
      'Microsoft Edge Beta',
      'Microsoft Edge Dev',
      'Microsoft Edge Canary',
    ].map(directory => join(homedir(), 'Library', 'Application Support', directory));
  }

  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA;
    return localAppData
      ? [
        'Google/Chrome',
        'Google/Chrome Beta',
        'Google/Chrome Dev',
        'Google/Chrome SxS',
        'Chromium',
        'Microsoft/Edge',
        'Microsoft/Edge Beta',
        'Microsoft/Edge Dev',
        'Microsoft/Edge SxS',
      ].map(directory => join(localAppData, directory, 'User Data'))
      : [];
  }

  return [
    'google-chrome',
    'google-chrome-beta',
    'google-chrome-unstable',
    'chromium',
    'microsoft-edge',
    'microsoft-edge-beta',
    'microsoft-edge-dev',
  ].map(directory => join(homedir(), '.config', directory));
}

function fixRemoteUrl(rawBrowserUrl: string, rawWebSocketUrl: string) {
  const browserUrl = new URL(rawBrowserUrl);
  const websocketUrl = new URL(rawWebSocketUrl);
  websocketUrl.host = browserUrl.host;
  return websocketUrl.toString();
}
