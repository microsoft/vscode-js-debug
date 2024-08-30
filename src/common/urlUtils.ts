/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { promises as dns } from 'dns';
import * as path from 'path';
import { parse as urlParse, URL } from 'url';
import Cdp from '../cdp/api';
import { AnyChromiumConfiguration } from '../configuration';
import { BrowserTargetType } from '../targets/browser/browserTargets';
import { iteratorFirst } from './arrayUtils';
import { MapUsingProjection } from './datastructure/mapUsingProjection';
import { IFsUtils } from './fsUtils';
import { memoize } from './objUtils';
import { fixDriveLetterAndSlashes, forceForwardSlashes, isUncPath } from './pathUtils';
import { escapeRegexSpecialChars, isRegexSpecialChar } from './stringUtils';

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

export function caseNormalizedMap<V>(): Map<string, V> {
  return getCaseSensitivePaths() ? new Map() : new MapUsingProjection(lowerCaseInsensitivePath);
}

const win32PathExt = process.platform === 'win32'
  ? process.env.PATHEXT?.toLowerCase().split(';')
  : undefined;

/**
 * Gets a case-normalized binary name suitable for comparison. On Windows,
 * removes any executable extension.
 */
export const getNormalizedBinaryName = (binaryPath: string) => {
  const filename = lowerCaseInsensitivePath(path.basename(binaryPath));
  if (win32PathExt) {
    for (const ext of win32PathExt) {
      if (filename.endsWith(ext)) {
        return filename.slice(0, -ext.length);
      }
    }
  }

  return filename;
};

/**
 * Returns the closest parent directory where the predicate returns truthy.
 */
export const nearestDirectoryWhere = async <T>(
  rootDir: string,
  predicate: (dir: string) => Promise<T | undefined>,
): Promise<T | undefined> => {
  while (true) {
    const value = await predicate(rootDir);
    if (value !== undefined) {
      return value;
    }

    const parent = path.dirname(rootDir);
    if (parent === rootDir) {
      return undefined;
    }

    rootDir = parent;
  }
};

/**
 * Returns the closest parent directory that contains a file with the given name.
 */
export const nearestDirectoryContaining = (fsUtils: IFsUtils, rootDir: string, file: string) =>
  nearestDirectoryWhere<string>(
    rootDir,
    async p => (await fsUtils.exists(path.join(p, file))) ? p : undefined,
  );

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
export const isLoopbackIp = (ipOrLocalhost: string) =>
  knownLoopbacks.has(ipOrLocalhost.toLowerCase());

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

export function getPathName(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.pathname;
  } catch {
    return undefined;
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

const vscodeWebviewResourceSchemeRe =
  /^https:\/\/([a-z0-9\-]+)\+\.vscode-resource\.vscode-(?:webview|cdn)\.net\/(.+)/i;
const vscodeAppResource = 'vscode-file://vscode-app/';

/**
 * If urlOrPath is a file URL, removes the 'file:///', adjusting for platform differences
 */
export function fileUrlToAbsolutePath(urlOrPath: FileUrl): string;
export function fileUrlToAbsolutePath(urlOrPath: string): string | undefined;
export function fileUrlToAbsolutePath(urlOrPath: string): string | undefined {
  const webviewResource = vscodeWebviewResourceSchemeRe.exec(urlOrPath);
  if (webviewResource) {
    urlOrPath = `${webviewResource[1]}:///${webviewResource[2]}`;
  } else if (urlOrPath.startsWith('vscode-webview-resource://')) {
    // todo@connor4312: is this still in use?
    const url = new URL(urlOrPath);
    // Strip off vscode webview url part: vscode-webview-resource://<36-char-guid>/file...
    urlOrPath = url.pathname
      .replace(/%2F/gi, '/')
      .replace(/^\/([a-z0-9\-]+)(\/{1,2})/i, (_: string, scheme: string, sep: string) => {
        if (sep.length === 1) {
          return `${scheme}:///`; // Add empty authority.
        } else {
          return `${scheme}://`; // Url has own authority.
        }
      });
  } else if (urlOrPath.startsWith(vscodeAppResource)) {
    urlOrPath = urlOrPath.slice(vscodeAppResource.length);
  } else if (!isFileUrl(urlOrPath)) {
    return undefined;
  }

  urlOrPath = urlOrPath.replace('file:///', '');
  urlOrPath = decodeURIComponent(urlOrPath);

  // UNC paths are returned from Chrome in the form `file:////shared/folder`,
  // rather than `file:///`. This is not _entirely_ prescriptive since some
  // applications can use four slashes for posix paths as well (even though V8
  // doesn't seem to), so only do this if the debugger is currently running on Windows.
  if (urlOrPath.startsWith('/') && process.platform === 'win32') {
    if (urlOrPath[1] !== '/') {
      urlOrPath = '/' + urlOrPath; // restore extra slash
    }
  }

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

// TODO: this does not escape/unescape special characters
/** @deprecated consider absolutePathToFileUrlWithDetection instead */
export function absolutePathToFileUrl(absolutePath: string): string {
  if (platform === 'win32') {
    return 'file:///' + platformPathToUrlPath(absolutePath);
  }
  return 'file://' + platformPathToUrlPath(absolutePath);
}

/**
 * Absolte path former that detects the platform based on the absolutePath
 * itself, rather than the platform where the debugger is running. This is
 * different from {@link absolutePathToFileUrl}, but should be more correct.
 */
export function absolutePathToFileUrlWithDetection(absolutePath: string): string {
  if (!absolutePath.startsWith('/')) {
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
export function isDataUri(uri: string | undefined | null): uri is string {
  return !!uri && uri.startsWith('data:');
}

const urlToRegexChar = (char: string, arr: Set<string>, escapeRegex: boolean) => {
  if (!escapeRegex || char === ':') {
    arr.add(char);
    return;
  }

  if (char === '/') {
    arr.add(`\\${char}`);
    return;
  }

  if (isRegexSpecialChar(char)) {
    arr.add(`\\${char}`);
  } else {
    arr.add(char);
  }

  const encoded = encodeURIComponent(char);
  if (char !== '\\' && encoded !== char) {
    arr.add(encoded); // will never have any regex special chars
  }
};

const createReGroup = (patterns: ReadonlySet<string>): string => {
  switch (patterns.size) {
    case 0:
      return '';
    case 1:
      return iteratorFirst(patterns.values()) as string;
    default:
      // Prefer the more compacy [aA] form if we're only matching single
      // characters, produce a non-capturing group otherwise.
      const arr = [...patterns];
      return arr.some(p => p.length > 1) ? `(?:${arr.join('|')})` : `[${arr.join('')}]`;
  }
};

const charToUrlReGroupSet = new Set<string>();
export function charRangeToUrlReGroup(
  str: string,
  start: number,
  end: number,
  escapeRegex: boolean,
  _isCaseSensitive = isCaseSensitive,
) {
  let re = '';

  // Loop through each character of the string. Convert the char to a regex,
  // creating a group, and then append that to the match.
  // Note that using "for..of" is important here to loop over UTF code points.
  for (const char of str.slice(start, end)) {
    if (_isCaseSensitive) {
      urlToRegexChar(char, charToUrlReGroupSet, escapeRegex);
    } else {
      urlToRegexChar(char.toLowerCase(), charToUrlReGroupSet, escapeRegex);
      urlToRegexChar(char.toUpperCase(), charToUrlReGroupSet, escapeRegex);
    }

    re += createReGroup(charToUrlReGroupSet);
    charToUrlReGroupSet.clear();
  }
  return re;
}

/**
 * Converts and escape the file URL to a regular expression.
 */
export function urlToRegex(
  aPath: string,
  [escapeReStart, escapeReEnd]: [number, number] = [0, aPath.length],
) {
  if (escapeReEnd <= escapeReStart) {
    return aPath;
  }

  const patterns: string[] = [];

  // Split out the portion of the path that has already been converted to a regex pattern
  const rePrefix = charRangeToUrlReGroup(aPath, 0, escapeReStart, false);
  const reSuffix = charRangeToUrlReGroup(aPath, escapeReEnd, aPath.length, false);
  const unescapedPath = aPath.slice(escapeReStart, escapeReEnd);

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
  for (const str of [decodeURIComponent(unescapedPath), fileUrlToAbsolutePath(unescapedPath)]) {
    if (!str) {
      continue;
    }

    const re = charRangeToUrlReGroup(str, 0, str.length, true);

    // If we're on windows but not case sensitive (i.e. we didn't expand a
    // fancy regex above), replace `file:///c:/` or simple `c:/` patterns with
    // an insensitive drive letter.
    patterns.push(
      makeDriveLetterReCaseInsensitive(`${rePrefix}${re}${reSuffix}`).concat('($|\\?)'),
    );
  }

  return patterns.join('|');
}

export const makeDriveLetterReCaseInsensitive = (re: string) =>
  re.replace(
    /^(file:\\\/\\\/\\\/)?([a-z]):/i,
    (_, file = '', letter) => `${file}[${letter.toUpperCase()}${letter.toLowerCase()}]:`,
  );

/**
 * Opaque typed used to indicate strings that are file URLs.
 */
export type FileUrl = string & { __opaque_file_url: true };

/**
 * Returns whether the string is a file URL
 */
export function isFileUrl(candidate: string): candidate is FileUrl {
  return candidate.startsWith('file:///');
}

export function maybeAbsolutePathToFileUrl(
  rootPath: string | undefined,
  sourceUrl: string,
): string {
  if (
    rootPath
    && platformPathToPreferredCase(sourceUrl).startsWith(rootPath)
    && !isValidUrl(sourceUrl)
  ) {
    return absolutePathToFileUrl(sourceUrl);
  }
  return sourceUrl;
}

let platform = process.platform;

export const overridePlatform = (newPlatform: NodeJS.Platform) => {
  platform = newPlatform;
};

export const resetPlatform = () => {
  platform = process.platform;
};

export function urlPathToPlatformPath(p: string): string {
  if (platform === 'win32') {
    p = p.replace(/\//g, '\\');
  }

  return decodeURI(p);
}

export function platformPathToUrlPath(p: string): string {
  p = platformPathToPreferredCase(p);

  if (platform === 'win32') {
    if (isUncPath(p)) {
      p = p.slice(1); // emit "file:////" and not "file://///" to match what V8 expects
    }
    return p
      .split(/[\\//]/g)
      .map((p, i) => (i > 0 ? encodeURIComponent(p) : p))
      .join('/');
  } else {
    return p.split('/').map(encodeURIComponent).join('/');
  }
}

export function platformPathToPreferredCase(p: string): string;
export function platformPathToPreferredCase(p: string | undefined): string | undefined;
export function platformPathToPreferredCase(p: string | undefined): string | undefined {
  if (p && platform === 'win32' && p[1] === ':') return p[0].toUpperCase() + p.substring(1);
  return p;
}

export type TargetFilter = (info: Cdp.Target.TargetInfo) => boolean;

/**
 * Creates a target filter function for the given Chrome configuration.
 */
export const createTargetFilterForConfig = (
  config: AnyChromiumConfiguration,
  additonalMatches: ReadonlyArray<string> = [],
): (t: { url: string }) => boolean => {
  const filter = config.urlFilter || ('file' in config && config.file) || config.url;
  const tester = filter ? createTargetFilter(filter, ...additonalMatches) : undefined;
  return t => !t.url.startsWith('devtools://') && tester?.(t.url) !== false;
};

/**
 * Requires that the target is also a 'page'.
 */
export const requirePageTarget = (
  filter: (t: Cdp.Target.TargetInfo) => boolean,
): (t: Cdp.Target.TargetInfo & { type: string }) => boolean =>
t =>
  // avoid #2018
  t.type === BrowserTargetType.Page && !t.url.startsWith('edge://force-signin') && filter(t);

/**
 * The "isURL" from chrome-debug-core. In js-debug we use `new URL()` to see
 * if a string is a URL, but this is slightly different from url.parse.
 * @see https://github.com/microsoft/vscode-chrome-debug-core/blob/456318b2a4b2d3394ce8daae1e70d898f55393ea/src/utils.ts#L310
 */
function isURLCompat(urlOrPath: string): boolean {
  return !!urlOrPath && !path.isAbsolute(urlOrPath) && !!urlParse(urlOrPath).protocol;
}

/**
 * Creates a function to filter a target URL.
 */
export const createTargetFilter = (
  ...targetUrls: ReadonlyArray<string>
): (testUrl: string) => boolean => {
  const standardizeMatch = (aUrl: string) => {
    aUrl = aUrl.toLowerCase();

    const fileUrl = fileUrlToAbsolutePath(aUrl);
    if (fileUrl) {
      // Strip file:///, if present
      aUrl = fileUrl;
    } else if (isURLCompat(aUrl) && aUrl.includes('://')) {
      // Strip the protocol, if present
      aUrl = aUrl.substr(aUrl.indexOf('://') + 3);
    }

    // Remove optional trailing /
    if (aUrl.endsWith('/')) {
      aUrl = aUrl.substr(0, aUrl.length - 1);
    }

    const hashIndex = aUrl.indexOf('#');
    if (hashIndex !== -1) {
      aUrl = aUrl.slice(0, aUrl[hashIndex - 1] === '/' ? hashIndex - 1 : hashIndex);
    }

    return aUrl;
  };

  const escaped = targetUrls.map(url =>
    escapeRegexSpecialChars(standardizeMatch(url), '/*').replace(/(\/\*$)|\*/g, '.*')
  );
  const targetUrlRegex = new RegExp('^(' + escaped.join('|') + ')$', 'g');

  return testUrl => {
    targetUrlRegex.lastIndex = 0;
    return targetUrlRegex.test(standardizeMatch(testUrl));
  };
};
