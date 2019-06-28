// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {URL} from 'url';
import * as events from 'events';

type HandlerFunction = (...args: any[]) => void;

interface Listener {
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
