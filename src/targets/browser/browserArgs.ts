/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { mapToArgs, ProcessArgs } from '../../common/processArgs';

/**
 * Gets the method through which the browser will expose CDP--either via
 * its stdio pipes, or on a port number.
 */
export type BrowserConnection = 'pipe' | number;

const debugPortArg = '--remote-debugging-port';
const debugPipeArg = '--remote-debugging-pipe';

/**
 * Type used for managing the list of arguments passed to the browser.
 */
export class BrowserArgs extends ProcessArgs {
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
}
