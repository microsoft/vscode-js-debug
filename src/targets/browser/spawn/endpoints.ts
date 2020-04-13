/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { CancellationToken } from 'vscode';
import * as URL from 'url';
import { delay } from '../../../common/promiseUtil';
import { BasicResourceProvider } from '../../../adapter/resourceProvider/basicResourceProvider';
import { promises as fs } from 'fs';

/**
 * Returns the debugger websocket URL a process listening at the given address.
 * @param browserURL -- Address like `http://localhost:1234`
 * @param cancellationToken -- Optional cancellation for this operation
 */
export async function getWSEndpoint(
  browserURL: string,
  cancellationToken: CancellationToken,
): Promise<string> {
  const provider = new BasicResourceProvider(fs);
  const jsonVersion = await provider.fetchJson<{ webSocketDebuggerUrl?: string }>(
    URL.resolve(browserURL, '/json/version'),
    cancellationToken,
  );
  if (jsonVersion.webSocketDebuggerUrl) {
    return jsonVersion.webSocketDebuggerUrl;
  }

  // Chrome its top-level debugg on /json/version, while Node does not.
  // Request both and return whichever one got us a string.
  const jsonList = await provider.fetchJson<{ webSocketDebuggerUrl: string }[]>(
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
