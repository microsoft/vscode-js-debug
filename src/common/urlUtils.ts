/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { URL } from 'url';
import * as path from 'path';
import { fixDriveLetterAndSlashes, forceForwardSlashes } from './pathUtils';
import { AnyChromiumConfiguration } from '../configuration';
import { escapeRegexSpecialChars, isRegexSpecialChar } from './stringUtils';
import { promises as dns } from 'dns';
import { memoize } from './objUtils';
import { exists } from './fsUtils';
import Cdp from '../cdp/api';

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
 * Compares the paths, case-insensitively based on the platform.
 */
export function comparePathsWithoutCasing(a: string, b: string) {
  return isCaseSensitive ? a === b : a.toLowerCase() === b.toLowerCase();
}

/**
 * Compares the paths, case-insensitively based on the platform, and
 * normalizing back- and forward-slashes.
 */
export function comparePathsWithoutCasingOrSlashes(a: string, b: string) {
  return comparePathsWithoutCasing(forceForwardSlashes(a), forceForwardSlashes(b));
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
const knownMetaAddresses = new Set<string>([
  '0.0.0.0',
  '::',
  '0000:0000:0000:0000:0000:0000:0000:0000',
]);

/**
 * Checks if the given address, well-formed loopback IPs. We don't need exotic
 * variations like `127.1` because `dns.lookup()` will resolve the proper
 * version for us. The "right" way would be to parse the IP to an integer
 * like Go does (https://golang.org/pkg/net/#IP.IsLoopback).
 */
const isLoopbackIp = (ipOrLocalhost: string) => knownLoopbacks.has(ipOrLocalhost.toLowerCase());

/**
 * If given a URL, returns its hostname.
 */
const getHostnameFromMaybeUrl = (maybeUrl: string) => {
  try {
    const url = new URL(maybeUrl);
    // replace brackets in ipv6 addresses:
    return url.hostname.replace(/^\[|\]$/g, '');
  } catch {
    return maybeUrl;
  }
};

/**
 * Gets whether the IP address is a meta-address like 0.0.0.0.
 */
export const isMetaAddress = (address: string) =>
  knownMetaAddresses.has(getHostnameFromMaybeUrl(address));

/**
 * Gets whether the IP is a loopback address.
 */
export const isLoopback = memoize(async (address: string) => {
  const ipOrHostname = getHostnameFromMaybeUrl(address);
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

export function completeUrl(base: string | undefined, relative: string): string | undefined {
  try {
    return new URL(relative, base).href;
  } catch (e) {}
}

export function removeQueryString(url: string) {
  try {
    const parsed = new URL(url);
    parsed.search = '';
    return parsed.toString();
  } catch {
    return url;
  }
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
export function absolutePathToFileUrl(absolutePath: string): string {
  if (process.platform === 'win32') {
    return 'file:///' + platformPathToUrlPath(absolutePath);
  }
  return 'file://' + platformPathToUrlPath(absolutePath);
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

const urlToRegexChar = (char: string, arr: Set<string>, escapeRegex: boolean) => {
  if (escapeRegex && isRegexSpecialChar(char)) {
    arr.add(`\\${char}`);
  } else {
    arr.add(char);
  }

  const encoded = encodeURI(char);
  if (char !== '\\' && encoded !== char) {
    arr.add(encoded); // will never have any regex special chars
  }
};

const createReGroup = (patterns: ReadonlySet<string>): string => {
  switch (patterns.size) {
    case 0:
      return '';
    case 1:
      return patterns.values().next().value;
    default:
      // Prefer the more compacy [aA] form if we're only matching single
      // characters, produce a non-capturing group otherwise.
      const arr = [...patterns];
      return arr.some(p => p.length > 1) ? `(?:${arr.join('|')})` : `[${arr.join('')}]`;
  }
};

/**
 * Converts and escape the file URL to a regular expression.
 */
export function urlToRegex(aPath: string, escapeRegex = true) {
  const patterns: string[] = [];

  // aPath will often (always?) be provided as a file URI, or URL. Decode it
  // --we'll reencode it as we go--and also create a match for its absolute
  // path.
  //
  // This de- and re-encoding is important for special characters, since:
  //  - It comes in like "file:///c:/foo/%F0%9F%92%A9.js"
  //  - We decode it to file:///c:/foo/💩.js
  //  - For case insensitive systems, we generate a regex like [fF][oO][oO]/(?:💩|%F0%9F%92%A9).[jJ][sS]
  //  - If we didn't de-encode it, the percent would be case-insensitized as
  //    well and we would not include the original character in the regex
  for (const str of [decodeURI(aPath), fileUrlToAbsolutePath(aPath)]) {
    if (!str) {
      continue;
    }

    // Loop through each character of the string. Convert the char to a regex,
    // creating a group, and then appent that to the match.
    const chars = new Set<string>();
    let re = '';
    for (const char of str) {
      if (isCaseSensitive) {
        urlToRegexChar(char, chars, escapeRegex);
      } else {
        urlToRegexChar(char.toLowerCase(), chars, escapeRegex);
        urlToRegexChar(char.toUpperCase(), chars, escapeRegex);
      }

      re += createReGroup(chars);
      chars.clear();
    }

    // If we're on windows but not case sensitive (i.e. we didn't expand a
    // fancy regex above), replace `file:///c:/` or simple `c:/` patterns with
    // an insensitive drive letter.
    patterns.push(
      re.replace(
        /^(file:\\\/\\\/\\\/)?([a-z]):/i,
        (_, file = '', letter) => `${file}[${letter.toUpperCase()}${letter.toLowerCase()}]:`,
      ),
    );
  }

  return patterns.join('|');
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
    return absolutePathToFileUrl(sourceUrl);
  return sourceUrl;
}

export function urlPathToPlatformPath(p: string): string {
  if (process.platform === 'win32') {
    p = p.replace(/\//g, '\\');
  }

  return decodeURI(p);
}

export function platformPathToUrlPath(p: string): string {
  p = platformPathToPreferredCase(p);
  if (process.platform === 'win32') {
    p = p.replace(/\\/g, '/');
  }

  return encodeURI(p);
}

export function platformPathToPreferredCase(p: string): string;
export function platformPathToPreferredCase(p: string | undefined): string | undefined;
export function platformPathToPreferredCase(p: string | undefined): string | undefined {
  if (p && process.platform === 'win32' && p[1] === ':') return p[0].toUpperCase() + p.substring(1);
  return p;
}

export type TargetFilter = (info: Cdp.Target.TargetInfo) => boolean;

/**
 * Creates a target filter function for the given Chrome configuration.
 */
export const createTargetFilterForConfig = (
  config: AnyChromiumConfiguration,
  additonalMatches: ReadonlyArray<string> = [],
): ((t: { url: string }) => boolean) => {
  const filter = config.urlFilter || config.url || ('file' in config && config.file);
  if (!filter) {
    return () => true;
  }

  const tester = createTargetFilter(filter, ...additonalMatches);
  return t => tester(t.url);
};

/**
 * Creates a function to filter a target URL.
 */
export const createTargetFilter = (
  ...targetUrls: ReadonlyArray<string>
): ((testUrl: string) => boolean) => {
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

  const escaped = targetUrls.map(url =>
    escapeRegexSpecialChars(standardizeMatch(url), '/*').replace(/\*/g, '.*'),
  );
  const targetUrlRegex = new RegExp('^(' + escaped.join('|') + ')$', 'g');

  return testUrl => {
    targetUrlRegex.lastIndex = 0;
    return targetUrlRegex.test(standardizeMatch(testUrl));
  };
};
