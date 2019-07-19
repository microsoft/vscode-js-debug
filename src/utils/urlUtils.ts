// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { URL } from 'url';
import * as fs from 'fs';

export async function fetch(url: string): Promise<string> {
  if (url.startsWith('data:')) {
    const prefix = url.substring(0, url.indexOf(','));
    const match = prefix.match(/data:[^;]*(;[^;]*)?(;[^;]*)?(;[^;]*)?/);
    if (!match)
      throw new Error(`Malformed data url prefix '${prefix}'`);
    const params = new Set<string>(match.slice(1));
    const data = url.substring(prefix.length + 1);
    const result = new Buffer(data, params.has(';base64') ? 'base64' : undefined).toString();
    return result;
  }

  if (url.startsWith('file://')) {
    const path = fileUrlToAbsolutePath(url);
    if (!path)
      throw new Error(`Can't fetch from '${url}'`);

    return new Promise<string>((fulfill, reject) => {
      fs.readFile(path!, (err: NodeJS.ErrnoException, data: Buffer) => {
        if (err)
          reject(err);
        else
          fulfill(data.toString());
      });
    });
  }

  const driver = url.startsWith('https://') ? require('https') : require('http');
  return new Promise<string>((fulfill, reject) => {
    const request = driver.get(url, response => {
      let data = '';
      response.setEncoding('utf8');
      response.on('data', chunk => data += chunk);
      response.on('end', () => fulfill(data));
      response.on('error', reject);
    });
    request.on('error', reject);
  });
};

export function completeUrl(base: string, relative: string): string | undefined {
  try {
    return new URL(relative, base).href;
  } catch (e) {
  }
};

export function isValidUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch (e) {
    return false;
  }
}

export function escapeForRegExp(s: string): string {
  const chars = '^[]{}()\\.^$*+?|-,';

  let foundChar = false;
  for (let i = 0; i < chars.length; ++i) {
    if (s.indexOf(chars.charAt(i)) !== -1) {
      foundChar = true;
      break;
    }
  }
  if (!foundChar)
    return s;

  let result = '';
  for (let i = 0; i < s.length; ++i) {
    if (chars.indexOf(s.charAt(i)) !== -1)
      result += '\\';
    result += s.charAt(i);
  }
  return result;
}

export function urlToRegExString(urlString: string): string {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch (e) {
    return '^' + escapeForRegExp(urlString) + '$';
  }
  if (url.protocol === 'about:' && url.pathname === 'blank')
    return '';
  if (url.protocol === 'data:')
    return '';
  let prefix = '';
  if (url.protocol && url.protocol !== 'http:' && url.protocol !== 'https') {
    prefix = '^' + url.protocol + '//';
    if (url.protocol === 'chrome-extension:')
      prefix += url.hostname + '\\b';
  }
  return prefix + escapeForRegExp(url.pathname) + (url.search ? '\\b' : '$');
}

export function positionToOffset(text: string, line: number, column: number): number {
  let offset = 0;
  const lines = text.split('\n');
  for (let l = 1; l < line; ++l)
    offset += lines[l - 1].length + 1;
  offset += column - 1;
  return offset;
}

export function fileUrlToAbsolutePath(url: string): string | undefined {
  try {
    const uri = new URL(url);
    if (uri.protocol !== 'file:')
      return;
    if (process.platform === 'win32')
      return uri.pathname.replace(/\//g, '\\').substring(1);
    return uri.pathname;
  } catch (e) {
  }
}

export function absolutePathToFileUrl(absolutePath: string): string | undefined {
  try {
    if (process.platform === 'win32')
      return 'file:///' + absolutePath.replace(/\\/g, '/');
    return 'file://' + absolutePath;
  } catch (e) {
  }
}

export function trimEnd(text: string, maxLength: number) {
  if (text.length <= maxLength)
    return text;
  return text.substr(0, maxLength - 1) + '…';
}
