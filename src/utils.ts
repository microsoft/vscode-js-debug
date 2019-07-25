/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import {URL} from 'url';

export function fetch(url: string): Promise<string> {
  let fulfill, reject;
  const promise: Promise<string> = new Promise((res, rej) => {
    fulfill = res;
    reject = rej;
  });
  const driver = url.startsWith('https://') ? require('https') : require('http');
  const request = driver.get(url, response => {
    let data = '';
    response.setEncoding('utf8');
    response.on('data', chunk => data += chunk);
    response.on('end', () => fulfill(data));
    response.on('error', reject);
  });
  request.on('error', reject);
  return promise;
};

export function completeUrl(base: string, relative: string): string | undefined {
  try {
    return new URL(relative, base).href;
  } catch (e) {
  }
};
