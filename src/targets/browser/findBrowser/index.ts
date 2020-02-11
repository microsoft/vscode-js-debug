/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { DarwinChromeBrowserFinder } from './darwinChrome';
import { WindowsChromeBrowserFinder } from './windowsChrome';
import { LinuxChromeBrowserFinder } from './linuxChrome';
import { WindowsEdgeBrowserFinder } from './windowsEdge';
import { DarwinEdgeBrowserFinder } from './darwinEdge';

/**
 * Quality (i.e. release channel) of discovered binary.
 */
export const enum Quality {
  Canary = 'canary',
  Stable = 'stable',
  Beta = 'beta',
  Dev = 'dev',
  Custom = 'custom', // environment-configured quality
}

// constructing it this way makes sure we can't forget to add a type:
const qualities: { [K in Quality]: null } = {
  [Quality.Canary]: null,
  [Quality.Stable]: null,
  [Quality.Beta]: null,
  [Quality.Dev]: null,
  [Quality.Custom]: null,
};

/**
 * All known qualities.
 */
export const allQualities: ReadonlySet<Quality> = new Set(Object.keys(qualities));

/**
 * Gets whether given string is a known Quality.
 */
export const isQuality = (input: string): input is Quality => allQualities.has(input as Quality);

/**
 * Discovered browser binary.
 */
export interface IExecutable {
  path: string;
  quality: Quality;
}

export const IBrowserFinder = Symbol('IBrowserFinder');

/**
 * Finds all browser executables available on the current platform.
 */
export interface IBrowserFinder {
  findAll(): Promise<IExecutable[]>;
}

/**
 * Chrome finder class for the current platform.
 */
export const ChromeBrowserFinder =
  process.platform === 'win32'
    ? WindowsChromeBrowserFinder
    : process.platform === 'darwin'
    ? DarwinChromeBrowserFinder
    : LinuxChromeBrowserFinder;

/**
 * Chrome finder class for the current platform.
 */
export const EdgeBrowserFinder =
  process.platform === 'win32' ? WindowsEdgeBrowserFinder : DarwinEdgeBrowserFinder;
