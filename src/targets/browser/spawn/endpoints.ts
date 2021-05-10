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
  isNode: boolean,
): Promise<string> {
  const provider = new BasicResourceProvider(fs);
  const [jsonVersion, jsonList] = await Promise.all([
    provider.fetchJson<{ webSocketDebuggerUrl?: string }>(
      URL.resolve(browserURL, '/json/version'),
      cancellationToken,
      { host: 'localhost' },
    ),
    // Chrome publishes its top-level debugg on /json/version, while Node does not.
    // Request both and return whichever one got us a string. ONLY try this on
    // Node, since it'll cause a failure on browsers (vscode#123420)
    isNode
      ? provider.fetchJson<{ webSocketDebuggerUrl: string }[]>(
          URL.resolve(browserURL, '/json/list'),
          cancellationToken,
          { host: 'localhost' },
        )
      : Promise.resolve(undefined),
  ]);

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

  if (!jsonList) {
    // no-op
  } else if (!jsonList.ok) {
    logger.verbose(LogTag.RuntimeLaunch, 'Error looking up /json/list', jsonList);
  } else {
    const fixed = fixRemoteUrl(browserURL, jsonList.body[0].webSocketDebuggerUrl);
    logger.verbose(LogTag.RuntimeLaunch, 'Discovered target URL from /json/list', {
      url: jsonList.body[0].webSocketDebuggerUrl,
      fixed,
    });
    return fixed;
  }

  throw new Error('Could not find any debuggable target');
}

const makeRetryGetWSEndpoint = (isNode: boolean) => async (
  browserURL: string,
  cancellationToken: CancellationToken,
  logger: ILogger,
): Promise<string> => {
  while (true) {
    try {
      return await getWSEndpoint(browserURL, cancellationToken, logger, isNode);
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

function fixRemoteUrl(rawBrowserUrl: string, rawWebSocketUrl: string) {
  const browserUrl = new URL.URL(rawBrowserUrl);
  const websocketUrl = new URL.URL(rawWebSocketUrl);
  websocketUrl.host = browserUrl.host;
  return websocketUrl.toString();
}
