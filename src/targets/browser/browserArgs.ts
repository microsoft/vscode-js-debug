/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { once } from '../../common/objUtils';

/**
 * Gets the method through which the browser will expose CDP--either via
 * its stdio pipes, or on a port number.
 */
export type BrowserConnection = 'pipe' | number;

const debugPortArg = '--remote-debugging-port';
const debugPipeArg = '--remote-debugging-pipe';

const argsToMap = (args: ReadonlyArray<string>) => {
  const map: { [key: string]: string | null } = {};
  for (const arg of args) {
    const delimiter = arg.indexOf('=');
    if (delimiter === -1) {
      map[arg] = null;
    } else {
      map[arg.slice(0, delimiter)] = arg.slice(delimiter + 1);
    }
  }

  return map;
};

const mapToArgs = (map: { [key: string]: string | null | undefined }) => {
  const out: string[] = [];
  for (const key of Object.keys(map)) {
    const value = map[key];
    if (value === undefined) {
      continue;
    }

    out.push(value === null ? key : `${key}=${value}`);
  }

  return out;
};

/**
 * Type used for managing the list of arguments passed to the browser.
 */
export class BrowserArgs {
  /**
   * Chrome default arguments.
   */
  public static readonly default = new BrowserArgs([
    '--disable-background-networking',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-breakpad',
    '--disable-client-side-phishing-detection',
    '--disable-default-apps',
    '--disable-dev-shm-usage',
    '--disable-renderer-backgrounding',
    '--disable-sync',
    '--metrics-recording-only',
    '--no-first-run',
    '--no-default-browser-check',
  ]);

  private readonly argMap = once(() => argsToMap(this.args));

  constructor(private readonly args: ReadonlyArray<string> = []) {}

  /**
   * Adds or overwrites an argument.
   */
  public add(key: string, value: string | null = null) {
    return new BrowserArgs(mapToArgs({ ...this.argMap(), [key]: value }));
  }

  /**
   * Removes an argument.
   */
  public remove(key: string) {
    return new BrowserArgs(mapToArgs({ ...this.argMap(), [key]: undefined }));
  }

  /**
   * Merges the set of arguments into this one.
   */
  public merge(args: ReadonlyArray<string> | BrowserArgs) {
    return new BrowserArgs(
      mapToArgs({
        ...this.argMap(),
        ...(args instanceof BrowserArgs ? args.argMap() : argsToMap(args)),
      }),
    );
  }

  /**
   * Sets the connection the browser args, returning an updated list of args.
   */
  public setConnection(connection: BrowserConnection): BrowserArgs {
    return new BrowserArgs(
      mapToArgs({
        ...this.argMap(),
        [debugPipeArg]: connection === 'pipe' ? null : undefined,
        [debugPortArg]: connection !== 'pipe' ? String(connection) : undefined,
      }),
    );
  }

  /**
   * Gets the preferred connection for this browser based on the arguments.
   */
  public getSuggestedConnection(): BrowserConnection | undefined {
    const args = this.argMap();
    if (args.hasOwnProperty(debugPipeArg)) {
      return 'pipe';
    }

    const port = args[debugPortArg];
    if (port === undefined) {
      return undefined;
    }

    return (port && Number(port)) || 0;
  }

  /**
   * Returns a new set of browser args that pass the predicate.
   */
  public filter(predicate: (key: string, value: string | null) => boolean) {
    const args = this.argMap();
    const out: string[] = [];
    for (const key of Object.keys(args)) {
      const value = args[key];
      if (!predicate(key, value)) {
        continue;
      }

      out.push(value === null ? key : `${key}=${value}`);
    }

    return new BrowserArgs(out);
  }

  /**
   * Gets the array of arguments.
   */
  public toArray() {
    return this.args.slice();
  }
}
