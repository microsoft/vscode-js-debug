/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { URL } from 'url';

/**
 * Returns WebSocket (`ws(s)://`) address of the inspector to use. This function interpolates the inspect uri from the browser inspect uri and other values. Available keys are:
 *
 *  - `url.*` is the parsed address of the running application. For instance,
 *    `{url.port}`, `{url.hostname}`
 *  - `port` is the debug port that Chrome is listening on.
 *  - `browserInspectUri` is the inspector URI on the launched browser
 *  - `wsProtocol` is the hinted websocket protocol. This is set to `wss` if the original URL is `https`, or `ws` otherwise.
 */
export function constructInspectorWSUri(
  inspectUriFormat: string,
  urlText: string | null | undefined,
  browserInspectUri: string,
): string {
  const url = new URL(urlText || '');
  const replacements: { [key: string]: string } = {
    'url.hostname': url.hostname,
    'url.port': url.port,
    browserInspectUri: browserInspectUri,
    wsProtocol: url.protocol === 'https' ? 'wss' : 'ws',
  };

  const inspectUri = inspectUriFormat.replace(/{([^\}]+)}/g, (match, key: string) =>
    replacements.hasOwnProperty(key) ? replacements[key] : match,
  );

  return inspectUri;
}
