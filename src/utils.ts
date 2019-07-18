// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { URL } from 'url';
import * as events from 'events';

type HandlerFunction = (...args: any[]) => void;

export interface Listener {
  emitter: events.EventEmitter;
  eventName: string;
  handler: HandlerFunction;
}

export function addEventListener(emitter: events.EventEmitter, eventName: string, handler: HandlerFunction): Listener {
  emitter.on(eventName, handler);
  return { emitter, eventName, handler };
}

export function removeEventListeners(listeners: Listener[]) {
  for (const listener of listeners)
    listener.emitter.removeListener(listener.eventName, listener.handler);
  listeners.splice(0, listeners.length);
}

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
