/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { URL } from 'url';
import { memoize } from '../../common/objUtils';

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
  const getUrl = memoize((maybeText: string | null | undefined) => {
    if (maybeText) {
      return new URL(maybeText);
    } else {
      throw new Error(`A valid url wasn't supplied: <${maybeText}>`);
    }
  });

  // We map keys to functions, so we won't fail with a missing url unless the inspector uri format is actually referencing the url
  const replacements: { [key: string]: () => string } = {
    'url.hostname': () => getUrl(urlText).hostname,
    'url.port': () => getUrl(urlText).port,
    browserInspectUri: () => encodeURIComponent(browserInspectUri),
    wsProtocol: () => (getUrl(urlText).protocol === 'https:' ? 'wss' : 'ws'), // the protocol includes the : at the end
  };

  const inspectUri = inspectUriFormat.replace(/{([^\}]+)}/g, (match, key: string) =>
    replacements.hasOwnProperty(key) ? replacements[key]() : match,
  );

  return inspectUri;
}
