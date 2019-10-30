// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as util from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
const puppeteer = require('puppeteer');
import { IChromeLaunchConfiguration, IChromeAttachConfiguration } from '../configuration';

export function setupUnhandledRejectionListener(): void {
  process.addListener('unhandledRejection', unhandledRejectionListener);
}

export function removeUnhandledRejectionListener(): void {
  process.removeListener('unhandledRejection', unhandledRejectionListener);
}

function unhandledRejectionListener(reason: any, _p: Promise<any>) {
  console.log('*');
  console.log('**');
  console.log('***');
  console.log('****');
  console.log('*****');
  console.log(
    `ERROR!! Unhandled promise rejection, a previous test may have failed but reported success.`,
  );
  console.log(reason.toString());
  console.log('*****');
  console.log('****');
  console.log('***');
  console.log('**');
  console.log('*');
}

/**
 * path.resolve + fixing the drive letter to match what VS Code does. Basically tests can use this when they
 * want to force a path to native slashes and the correct letter case, but maybe can't use un-mocked utils.
 */
export function pathResolve(...segments: string[]): string {
  let aPath = path.resolve.apply(null, segments);

  if (aPath.match(/^[A-Za-z]:/)) {
    aPath = aPath[0].toLowerCase() + aPath.substr(1);
  }

  return aPath;
}

/**
 * Kills all running instances of chrome (that were launched by the tests, on Windows at least) on the test host
 */
export function killAllChrome() {
  try {
    const killCmd =
      process.platform === 'win32'
        ? `start powershell -WindowStyle hidden -Command "Get-Process | Where-Object {$_.Path -like '*${puppeteer.executablePath()}*'} | Stop-Process"`
        : 'killall chrome';
    const hideWindows = process.env['TEST_DA_HIDE_WINDOWS'] === 'true';
    const output = execSync(killCmd, { windowsHide: hideWindows }); // TODO: windowsHide paramenter doesn't currently work. It might be related to this: https://github.com/nodejs/node/issues/21825
    if (output.length > 0) {
      // Don't print empty lines
      console.log(output.toString());
    }
  } catch (e) {
    console.error(`Error killing chrome: ${e.message}`);
  }
  // the kill command will exit with a non-zero code (and cause execSync to throw) if chrome is already stopped
}

export const readFileP = util.promisify(fs.readFile);
export const writeFileP = util.promisify(fs.writeFile);

export type PromiseOrNot<T> = T | Promise<T>;

export interface IDeferred<T> {
  resolve: (result: T) => void;
  reject: (err: Error) => void;
  promise: Promise<T>;
}

export function getDeferred<T>(): Promise<IDeferred<T>> {
  return new Promise(r => {
      // Promise callback is called synchronously
      let resolve: IDeferred<T>['resolve'] = () => { throw new Error('Deferred was resolved before intialization'); };
      let reject: IDeferred<T>['reject'] = () => { throw new Error('Deferred was rejected before initialization'); };
      let promise = new Promise<T>((_resolve, _reject) => {
          resolve = _resolve;
          reject = _reject;
      });

      r({ resolve, reject, promise });
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

export function promiseTimeout(
  p?: Promise<any>,
  timeoutMs = 1000,
  timeoutMsg?: string,
): Promise<any> {
  if (timeoutMsg === undefined) {
    timeoutMsg = `Promise timed out after ${timeoutMs}ms`;
  }

  return new Promise((resolve, reject) => {
    if (p) {
      p.then(resolve, reject);
    }

    setTimeout(() => {
      if (p) {
        reject(new Error(timeoutMsg));
      } else {
        resolve();
      }
    }, timeoutMs);
  });
}

export function retryAsync(
  fn: () => Promise<any>,
  timeoutMs: number,
  intervalDelay = 0,
): Promise<any> {
  const startTime = Date.now();

  function tryUntilTimeout(): Promise<any> {
    return fn().catch(e => {
      if (Date.now() - startTime < timeoutMs - intervalDelay) {
        return promiseTimeout(undefined, intervalDelay).then(tryUntilTimeout);
      } else {
        return errP(e);
      }
    });
  }

  return tryUntilTimeout();
}

/**
 * A helper for returning a rejected promise with an Error object. Avoids double-wrapping an Error, which could happen
 * when passing on a failure from a Promise error handler.
 * @param msg - Should be either a string or an Error
 */
export function errP(msg: string | Error): Promise<never> {
  const isErrorLike = (thing: any): thing is Error => !!thing.message;

  let e: Error;
  if (!msg) {
    e = new Error('Unknown error');
  } else if (isErrorLike(msg)) {
    // msg is already an Error object
    e = msg;
  } else {
    e = new Error(msg);
  }

  return Promise.reject(e);
}

export interface IChromeTestLaunchConfiguration extends Partial<IChromeLaunchConfiguration> {
  request: 'launch';
  url: string;
}

export interface IChromeTestAttachConfiguration extends Partial<IChromeAttachConfiguration> {
  url: string;
}

/**
 * Convert a local path to a file URL, like
 * C:/code/app.js => file:///C:/code/app.js
 * /code/app.js => file:///code/app.js
 * \\code\app.js => file:///code/app.js
 */
export function pathToFileURL(_absPath: string, normalize?: boolean): string {
  let absPath = forceForwardSlashes(_absPath);
  if (isTrue(normalize)) {
    absPath = path.normalize(absPath);
    absPath = forceForwardSlashes(absPath);
  }

  const filePrefix = _absPath.startsWith('\\\\')
    ? 'file:/'
    : absPath.startsWith('/')
    ? 'file://'
    : 'file:///';

  absPath = filePrefix + absPath;
  return encodeURI(absPath);
}

/**
 * Replace any backslashes with forward slashes
 * blah\something => blah/something
 */
function forceForwardSlashes(aUrl: string): string {
  return aUrl
    .replace(/\\\//g, '/') // Replace \/ (unnecessarily escaped forward slash)
    .replace(/\\/g, '/');
}

/**
 * Returns whether the parameter is defined and is true
 */
function isTrue(booleanOrUndefined: boolean | undefined): boolean {
  return booleanOrUndefined === true;
}
