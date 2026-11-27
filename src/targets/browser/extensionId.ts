/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { createHash } from 'crypto';
import * as path from 'path';
import { ILogger, LogTag } from '../../common/logging';
import { FsPromises } from '../../ioc-extras';
import { BrowserTargetType } from './browserTargets';

/**
 * Chrome derives an extension ID by hashing a seed, taking the first 16 bytes
 * of the digest, and mapping each hex nibble onto the letters a-p.
 */
const digestToExtensionId = (digest: Buffer) =>
  [...digest.subarray(0, 16)]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
    .replace(/[0-9a-f]/g, nibble => String.fromCharCode(97 + parseInt(nibble, 16)));

/**
 * Computes the extension ID Chrome assigns to an extension declaring the given
 * `key` in its manifest. This is stable across machines and profiles.
 */
export const extensionIdFromManifestKey = (key: string) =>
  digestToExtensionId(createHash('sha256').update(Buffer.from(key, 'base64')).digest());

/**
 * Computes the extension ID Chrome assigns to an unpacked extension loaded from
 * the given absolute path, for manifests with no `key`. Chrome hashes the path
 * as it spells it internally, so this is best-effort: on Windows it uses
 * backslashes and an upper-case drive letter.
 */
export const extensionIdFromPath = (absolutePath: string) => {
  let seed = path.resolve(absolutePath);
  if (process.platform === 'win32') {
    seed = seed.replace(/\//g, '\\').replace(/^([a-z]):/, (_, drive) => `${drive.toUpperCase()}:`);
  }

  return digestToExtensionId(createHash('sha256').update(seed, 'utf8').digest());
};

/**
 * Resolves the ID Chrome is expected to assign to the unpacked extension at
 * `extensionPath`. Prefers the manifest `key` (exact) and falls back to hashing
 * the path (best-effort). Returns undefined if the manifest can't be read.
 */
export async function resolveExpectedExtensionId(
  extensionPath: string,
  fs: FsPromises,
): Promise<string | undefined> {
  let key: string | undefined;
  try {
    const raw = await fs.readFile(path.join(extensionPath, 'manifest.json'), 'utf8');
    key = JSON.parse(raw).key;
  } catch {
    return undefined; // no readable manifest; caller falls back to a loose match
  }

  return typeof key === 'string' && key
    ? extensionIdFromManifestKey(key)
    : extensionIdFromPath(extensionPath);
}

/**
 * Name of the browser profile directory used when debugging the extension at
 * `extensionPath`. Keyed by the extension ID plus a hash of the path, since
 * unrelated extensions can declare the same manifest `key` (and thus the same
 * ID). Deliberately short: the profile prefixes IndexedDB's LevelDB paths,
 * which add ~106 characters for an extension origin — a profile base past
 * ~135 characters exceeds MAX_PATH on Windows and breaks the extension's
 * IndexedDB with "Internal error opening database".
 */
export const extensionProfileDirName = (extensionPath: string, extensionId?: string) => {
  const id = extensionId ?? extensionIdFromPath(extensionPath);
  const pathHash = createHash('sha256').update(extensionPath).digest('hex').slice(0, 8);
  return `js-debug-ext-${id.slice(0, 8)}-${pathHash}`;
};

/** Target types an extension's own code can run in. */
const extensionTargetTypes: ReadonlySet<string> = new Set([
  BrowserTargetType.ServiceWorker,
  BrowserTargetType.Page,
]);

const extensionUrlId = (url: string) => url.match(/^chrome-extension:\/\/([a-p]{32})\//)?.[1];

/**
 * Builds a target filter that selects the background service worker or page of
 * the extension at `extensionPath`.
 *
 * Browsers expose service workers for their own component extensions too, and
 * those can be reported before the extension under debug, so matching any
 * `chrome-extension://` target would attach to the wrong one. When the expected
 * ID is known we require an exact match; otherwise we warn, because the first
 * match may not be the intended extension.
 */
export const createExtensionTargetFilter = (
  extensionPath: string,
  expectedId: string | undefined,
  logger: ILogger,
): (t: { url: string; type: string }) => boolean => {
  if (!expectedId) {
    logger.warn(
      LogTag.RuntimeTarget,
      'Could not determine the extension ID; will attach to the first extension '
        + 'target seen, which may not be the extension under debug',
      { extensionPath },
    );
  }

  return t => {
    if (!extensionTargetTypes.has(t.type)) {
      return false;
    }

    const id = extensionUrlId(t.url);
    if (!id) {
      return false;
    }

    return expectedId === undefined || id === expectedId;
  };
};
