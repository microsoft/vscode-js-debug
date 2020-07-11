/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { promises as fs } from 'fs';
import * as URL from 'url';
import { CancellationToken } from 'vscode';
import { BasicResourceProvider } from '../../../adapter/resourceProvider/basicResourceProvider';
import { ILogger, LogTag } from '../../../common/logging';
import { delay } from '../../../common/promiseUtil';

/**
 * Returns the debugger websocket URL a process listening at the given address.
 * @param browserURL -- Address like `http://localhost:1234`
 * @param cancellationToken -- Optional cancellation for this operation
 */
export async function getWSEndpoint(
  browserURL: string,
  cancellationToken: CancellationToken,
  logger: ILogger,
): Promise<string> {
  const provider = new BasicResourceProvider(fs);
  const jsonVersion = await provider.fetchJson<{ webSocketDebuggerUrl?: string }>(
    URL.resolve(browserURL, '/json/version'),
    cancellationToken,
    { host: 'localhost' },
  );

  if (!jsonVersion.ok) {
    logger.verbose(LogTag.RuntimeLaunch, 'Error looking up /json/version', jsonVersion);
  } else if (jsonVersion.body.webSocketDebuggerUrl) {
    const fixed = fixRemoteUrl(browserURL, jsonVersion.body.webSocketDebuggerUrl);
    logger.verbose(LogTag.RuntimeLaunch, 'Discovered target URL from /json/version', {
      url: jsonVersion.body.webSocketDebuggerUrl,
      fixed,
    });
    return fixed;
  }

  // Chrome its top-level debugg on /json/version, while Node does not.
  // Request both and return whichever one got us a string.
  const jsonList = await provider.fetchJson<{ webSocketDebuggerUrl: string }[]>(
    URL.resolve(browserURL, '/json/list'),
    cancellationToken,
    { host: 'localhost' },
  );

  if (!jsonList.ok) {
    logger.verbose(LogTag.RuntimeLaunch, 'Error looking up /json/list', jsonList);
  } else if (jsonList.body.length) {
    const fixed = fixRemoteUrl(browserURL, jsonList.body[0].webSocketDebuggerUrl);
    logger.verbose(LogTag.RuntimeLaunch, 'Discovered target URL from /json/list', {
      url: jsonList.body[0].webSocketDebuggerUrl,
      fixed,
    });
    return fixed;
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
  logger: ILogger,
): Promise<string> {
  try {
    return await getWSEndpoint(browserURL, cancellationToken, logger);
  } catch (e) {
    if (cancellationToken.isCancellationRequested) {
      throw new Error(`Could not connect to debug target at ${browserURL}: ${e.message}`);
    }

    await delay(200);
    return retryGetWSEndpoint(browserURL, cancellationToken, logger);
  }
}

function fixRemoteUrl(rawBrowserUrl: string, rawWebSocketUrl: string) {
  const browserUrl = new URL.URL(rawBrowserUrl);
  const websocketUrl = new URL.URL(rawWebSocketUrl);
  websocketUrl.host = browserUrl.host;
  return websocketUrl.toString();
}
