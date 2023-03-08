/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { URL } from 'url';
import { absolutePathToFileUrlWithDetection } from '../../common/urlUtils';
import { AnyChromiumConfiguration } from '../../configuration';

export function baseURL(params: AnyChromiumConfiguration): string | undefined {
  if ('file' in params && params.file) {
    return absolutePathToFileUrlWithDetection(params.file);
  }

  if (params.url) {
    try {
      const baseUrl = new URL(params.url);
      baseUrl.pathname = '/';
      baseUrl.search = '';
      baseUrl.hash = '';
      if (baseUrl.protocol === 'data:') return undefined;
      return baseUrl.href;
    } catch (e) {}
  }
}
