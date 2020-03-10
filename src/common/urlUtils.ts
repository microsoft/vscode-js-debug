/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { URL } from 'url';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as https from 'https';
import { fixDriveLetterAndSlashes } from './pathUtils';
import { AnyChromiumConfiguration } from '../configuration';
import { escapeRegexSpecialChars } from './stringUtils';
import { promises as dns } from 'dns';
import { memoize } from './objUtils';
import { exists } from './fsUtils';
import { IDisposable } from './disposable';
import { TaskCancelledError, NeverCancelled } from './cancellation';
import { CancellationToken } from 'vscode';

let isCaseSensitive = process.platform !== 'win32';

export function resetCaseSensitivePaths() {
  isCaseSensitive = process.platform !== 'win32';
}

export function setCaseSensitivePaths(sensitive: boolean) {
  isCaseSensitive = sensitive;
}

export function getCaseSensitivePaths() {
  return isCaseSensitive;
}

/**
 * Lowercases the path if the filesystem is case-insensitive. Warning: this
 * should only be done for the purposes of comparing paths. Paths returned
 * through DAP and other protocols should be correctly-cased to avoid incorrect
 * disambiguation.
 */
export function lowerCaseInsensitivePath(path: string) {
  return isCaseSensitive ? path : path.toLowerCase();
}

/**
 * Returns the closest parent directory where the predicate returns true.
 */
export const nearestDirectoryWhere = async (
  rootDir: string,
  predicate: (dir: string) => Promise<boolean>,
): Promise<string | undefined> => {
  while (true) {
    const parent = path.dirname(rootDir);
    if (parent === rootDir) {
      return undefined;
    }

    if (await predicate(parent)) {
      return parent;
    }

    rootDir = parent;
  }
};

/**
 * Returns the closest parent directory that contains a file with the given name.
 */
export const nearestDirectoryContaining = (rootDir: string, file: string) =>
  nearestDirectoryWhere(rootDir, p => exists(path.join(p, file)));

// todo: not super correct, and most node libraries don't handle this accurately
const knownLoopbacks = new Set<string>(['localhost', '127.0.0.1', '::1']);

/**
 * Checks if the given address, well-formed loopback IPs. We don't need exotic
 * variations like `127.1` because `dns.lookup()` will resolve the proper
 * version for us. The "right" way would be to parse the IP to an integer
 * like Go does (https://golang.org/pkg/net/#IP.IsLoopback).
 */
const isLoopbackIp = (ipOrLocalhost: string) => knownLoopbacks.has(ipOrLocalhost.toLowerCase());

/**
 * Gets whether the IP is a loopback address.
 */
export const isLoopback = memoize(async (address: string) => {
  let ipOrHostname: string;
  try {
    const url = new URL(address);
    // replace brackets in ipv6 addresses:
    ipOrHostname = url.hostname.replace(/^\[|\]$/g, '');
  } catch {
    ipOrHostname = address;
  }

  if (isLoopbackIp(ipOrHostname)) {
    return true;
  }

  try {
    const resolved = await dns.lookup(ipOrHostname);
    return isLoopbackIp(resolved.address);
  } catch {
    return false;
  }
});

/**
 * Fetches JSON content from the given URL.
 */
export async function fetchJson<T>(url: string, cancellationToken: CancellationToken): Promise<T> {
  const data = await fetch(url, cancellationToken);
  return JSON.parse(data);
}

/**
 * Fetches content from the given URL.
 */
export async function fetch(
  url: string,
  cancellationToken: CancellationToken = NeverCancelled,
): Promise<string> {
  if (url.startsWith('data:')) {
    const prefix = url.substring(0, url.indexOf(','));
    const match = prefix.match(/data:[^;]*(;[^;]*)?(;[^;]*)?(;[^;]*)?/);
    if (!match) throw new Error(`Malformed data url prefix '${prefix}'`);
    const params = new Set<string>(match.slice(1));
    const data = url.substring(prefix.length + 1);
    const result = Buffer.from(data, params.has(';base64') ? 'base64' : undefined).toString();
    return result;
  }

  const absolutePath = isAbsolute(url) ? url : fileUrlToAbsolutePath(url);
  if (absolutePath) {
    return new Promise<string>((fulfill, reject) => {
      fs.readFile(absolutePath, (err, data) => {
        if (err) reject(err);
        else fulfill(data.toString());
      });
    });
  }

  const isSecure = !url.startsWith('http://');
  const driver = isSecure ? https : http;
  const targetAddressIsLoopback = await isLoopback(url);
  const disposables: IDisposable[] = [];

  return new Promise<string>((fulfill, reject) => {
    const requestOptions: https.RequestOptions = {};

    if (isSecure && targetAddressIsLoopback) {
      requestOptions.rejectUnauthorized = false;
    }

    const request = driver.get(url, requestOptions, response => {
      disposables.push(cancellationToken.onCancellationRequested(() => response.destroy()));

      let data = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => (data += chunk));
      response.on('end', () => fulfill(data));
      response.on('error', reject);
    });

    disposables.push(
      cancellationToken.onCancellationRequested(() => {
        request.destroy();
        reject(new TaskCancelledError(`Cancelled GET ${url}`));
      }),
    );

    request.on('error', reject);
    request.end();
  }).finally(() => disposables.forEach(d => d.dispose()));
}

export function completeUrl(base: string | undefined, relative: string): string | undefined {
  try {
    return new URL(relative, base).href;
  } catch (e) {}
}

// This function allows relative path to escape the root:
// "http://example.com/foo/bar.js" + "../../baz/qux.js" => "http://example.com/../baz/qux.js"
// This allows relative source map sources to reference outside of webRoot.
export function completeUrlEscapingRoot(base: string | undefined, relative: string): string {
  try {
    new URL(relative);
    return relative;
  } catch (e) {}

  let url: URL;
  try {
    url = new URL(base || '');
  } catch (e) {
    return relative;
  }

  let s = url.protocol + '//';
  if (url.username) s += url.username + ':' + url.password + '@';
  s += url.host;
  s += path.dirname(url.pathname);
  if (s[s.length - 1] !== '/') s += '/';
  s += relative;
  return s;
}

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
  if (!foundChar) return s;

  let result = '';
  for (let i = 0; i < s.length; ++i) {
    if (chars.indexOf(s.charAt(i)) !== -1) result += '\\';
    result += s.charAt(i);
  }
  return result;
}

/**
 * Remove a slash of any flavor from the end of the path
 */
export function stripTrailingSlash(aPath: string): string {
  return aPath.replace(/\/$/, '').replace(/\\$/, '');
}

/**
 * If urlOrPath is a file URL, removes the 'file:///', adjusting for platform differences
 */
export function fileUrlToAbsolutePath(urlOrPath: FileUrl): string;
export function fileUrlToAbsolutePath(urlOrPath: string): string | undefined;
export function fileUrlToAbsolutePath(urlOrPath: string): string | undefined {
  if (!isFileUrl(urlOrPath)) {
    return undefined;
  }

  urlOrPath = urlOrPath.replace('file:///', '');
  urlOrPath = decodeURIComponent(urlOrPath);
  if (urlOrPath[0] !== '/' && !urlOrPath.match(/^[A-Za-z]:/)) {
    // If it has a : before the first /, assume it's a windows path or url.
    // Ensure unix-style path starts with /, it can be removed when file:/// was stripped.
    // Don't add if the url still has a protocol
    urlOrPath = '/' + urlOrPath;
  }

  return fixDriveLetterAndSlashes(urlOrPath);
}

/**
 * Converts a file URL to a windows network path, if possible.
 */
export function fileUrlToNetworkPath(urlOrPath: string): string {
  if (isFileUrl(urlOrPath)) {
    urlOrPath = urlOrPath.replace('file:///', '\\\\');
    urlOrPath = urlOrPath.replace(/\//g, '\\');
    urlOrPath = decodeURIComponent(urlOrPath);
  }

  return urlOrPath;
}

// TODO: this does not escape/unescape special characters, but it should.
export function absolutePathToFileUrl(absolutePath: string): string | undefined {
  try {
    if (process.platform === 'win32') return 'file:///' + platformPathToUrlPath(absolutePath);
    return 'file://' + platformPathToUrlPath(absolutePath);
  } catch (e) {}
}

/**
 * Returns whether the path is a Windows or posix path.
 */
export function isAbsolute(_path: string): boolean {
  return path.posix.isAbsolute(_path) || path.win32.isAbsolute(_path);
}

/**
 * Returns whether the uri looks like a data URI.
 */
export function isDataUri(uri: string): boolean {
  return /^data:[a-z]+\/[a-z]/.test(uri);
}

/**
 * Converts and escape the file URL to a regular expression.
 */
export function urlToRegex(aPath: string) {
  const absolutePath = fileUrlToAbsolutePath(aPath);
  aPath = escapeRegexSpecialChars(aPath);
  if (absolutePath) {
    aPath += `|${escapeRegexSpecialChars(absolutePath)}`;
  }

  // If we should resolve paths in a case-sensitive way, we still need to set
  // the BP for either an upper or lowercased drive letter
  if (isCaseSensitive) {
    aPath = aPath.replace(
      /(^|\|)(file:\\\/\\\/\\\/)?([a-zA-Z]):/g,
      (_match, start = '', file = '', letter) => {
        const upper = letter.toUpperCase();
        const lower = letter.toLowerCase();
        return `${start}${file}[${upper}${lower}]:`;
      },
    );
  } else {
    aPath = aPath.replace(/[a-z]/gi, letter => `[${letter.toLowerCase()}${letter.toUpperCase()}]`);
  }

  // In some environments, Chrome(/Electron) doesn't escape spaces in paths.
  // This was observed in the "Launch VS Code" configuration.
  aPath = aPath.replace(/ |%20/g, '( |%20)');

  return aPath;
}

/**
 * Opaque typed used to indicate strings that are file URLs.
 */
export type FileUrl = string & { __opaque_file_url: true };

/**
 * Returns whether the string is a file UR
 */
export function isFileUrl(candidate: string): candidate is FileUrl {
  return candidate.startsWith('file:///');
}

export function maybeAbsolutePathToFileUrl(
  rootPath: string | undefined,
  sourceUrl: string,
): string {
  if (
    rootPath &&
    platformPathToPreferredCase(sourceUrl).startsWith(rootPath) &&
    !isValidUrl(sourceUrl)
  )
    return absolutePathToFileUrl(sourceUrl) || sourceUrl;
  return sourceUrl;
}

export function urlPathToPlatformPath(p: string): string {
  if (process.platform === 'win32') return p.replace(/\//g, '\\');
  return p;
}

export function platformPathToUrlPath(p: string): string {
  p = platformPathToPreferredCase(p);
  if (process.platform === 'win32') {
    p = p.replace(/\\/g, '/');
  }

  return p.replace(/ /g, '%20');
}

export function platformPathToPreferredCase(p: string): string;
export function platformPathToPreferredCase(p: string | undefined): string | undefined;
export function platformPathToPreferredCase(p: string | undefined): string | undefined {
  if (p && process.platform === 'win32' && p[1] === ':') return p[0].toUpperCase() + p.substring(1);
  return p;
}

/**
 * Creates a target filter function for the given Chrome configuration.
 */
export const createTargetFilterForConfig = (
  config: AnyChromiumConfiguration,
): ((t: { url: string }) => boolean) => {
  const filter = config.urlFilter || config.url || ('file' in config && config.file);
  if (!filter) {
    return () => true;
  }

  const tester = createTargetFilter(filter);
  return t => tester(t.url);
};

/**
 * Creates a function to filter a target URL.
 */
export const createTargetFilter = (targetUrl: string): ((testUrl: string) => boolean) => {
  const standardizeMatch = (aUrl: string) => {
    aUrl = aUrl.toLowerCase();

    const fileUrl = fileUrlToAbsolutePath(aUrl);
    if (fileUrl) {
      // Strip file:///, if present
      aUrl = fileUrl;
    } else if (isValidUrl(aUrl) && aUrl.includes('://')) {
      // Strip the protocol, if present
      aUrl = aUrl.substr(aUrl.indexOf('://') + 3);
    }

    // Remove optional trailing /
    if (aUrl.endsWith('/')) {
      aUrl = aUrl.substr(0, aUrl.length - 1);
    }

    return aUrl;
  };

  targetUrl = escapeRegexSpecialChars(standardizeMatch(targetUrl), '/*').replace(/\*/g, '.*');
  const targetUrlRegex = new RegExp('^' + targetUrl + '$', 'g');

  return testUrl => {
    targetUrlRegex.lastIndex = 0;
    return targetUrlRegex.test(standardizeMatch(testUrl));
  };
};
