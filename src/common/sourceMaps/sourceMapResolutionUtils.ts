/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { promises as fs } from 'fs';
import * as path from 'path';
import { URL } from 'url';
import * as utils from '../../common/urlUtils';
import { PathMapping } from '../../configuration';
import { IFsUtils } from '../fsUtils';
import { ILogger, LogTag } from '../logging';
import { filterObject } from '../objUtils';
import {
  fixDriveLetter,
  fixDriveLetterAndSlashes,
  forceForwardSlashes,
  properJoin,
  properResolve,
} from '../pathUtils';

export function getFullSourceEntry(sourceRoot: string | undefined, sourcePath: string): string {
  if (!sourceRoot) {
    return sourcePath;
  }

  if (!sourceRoot.endsWith('/')) {
    sourceRoot += '/';
  }

  return sourceRoot + sourcePath;
}

/**
 * Gets the best source root out of the set of path mappings.
 */
export async function getComputedSourceRoot(
  sourceRoot: string,
  generatedPath: string,
  resolver: PathMappingResolver,
  logger: ILogger,
): Promise<string> {
  generatedPath = utils.fileUrlToAbsolutePath(generatedPath) || generatedPath;

  let absSourceRoot: string;
  if (sourceRoot) {
    if (utils.isFileUrl(sourceRoot)) {
      // sourceRoot points to a local path like "file:///c:/project/src", make it an absolute path
      absSourceRoot = utils.fileUrlToAbsolutePath(sourceRoot);
    } else if (utils.isAbsolute(sourceRoot)) {
      // sourceRoot is like "/src", should be like http://localhost/src, resolve to a local path using pathMaping.
      // If path mappings do not apply (e.g. node), assume that sourceRoot is actually a local absolute path.
      // Technically not valid but it's easy to end up with paths like this.
      absSourceRoot = (await resolver(sourceRoot))?.mapped || sourceRoot;

      // If no pathMapping (node), use sourceRoot as is.
      // But we also should handle an absolute sourceRoot for chrome? Does CDT handle that? No it does not, it interprets it as "localhost/full path here"
    } else if (path.isAbsolute(generatedPath)) {
      // sourceRoot is like "src" or "../src", relative to the script
      absSourceRoot = resolveRelativeToFile(generatedPath, sourceRoot);
    } else {
      // generatedPath is a URL so runtime script is not on disk, resolve the sourceRoot location on disk.
      const generatedUrlPath = new URL(generatedPath).pathname;
      const mappedPath = await resolver(generatedUrlPath);
      const mappedDirname = path.dirname(mappedPath?.mapped || generatedUrlPath);
      absSourceRoot = properJoin(mappedDirname, sourceRoot);
    }

    logger.verbose(LogTag.SourceMapParsing, `resolved sourceRoot`, { sourceRoot, absSourceRoot });
  } else if (path.isAbsolute(generatedPath)) {
    absSourceRoot = path.dirname(generatedPath);
    logger.verbose(LogTag.SourceMapParsing, `no sourceRoot specified, using script dirname`, {
      absSourceRoot,
    });
  } else {
    // No sourceRoot and runtime script is not on disk, resolve the sourceRoot location on disk
    const urlPathname = new URL(generatedPath).pathname || '/placeholder.js'; // could be debugadapter://123, no other info.
    const mappedPath = await resolver(urlPathname);
    const scriptPathDirname = mappedPath ? path.dirname(mappedPath.mapped) : '';
    absSourceRoot = scriptPathDirname;
    logger.verbose(
      LogTag.SourceMapParsing,
      `no sourceRoot specified, using webRoot + script path dirname`,
      { absSourceRoot },
    );
  }

  absSourceRoot = utils.stripTrailingSlash(absSourceRoot);
  absSourceRoot = fixDriveLetterAndSlashes(absSourceRoot);

  return absSourceRoot;
}

/**
 * Takes the path component of a target url (starting with '/') and applies
 * pathMapping, returning a remapped absolute path.
 *
 * For instance, if the path is given as `/foo/bar.js` and there's a mapping
 * for `{ '/foo': '/baz' }` this would return `/baz/bar.js`.
 */
export type PathMappingResolver = (
  scriptUrlOrPath: string,
) => Promise<PathMapInfo | undefined> | PathMapInfo | undefined;

type PathMapInfo = { pattern: string; mapped: string; match: string };

/**
 * Applies path mapping to an object like `{ 'C:/Foo': '/foo' }`
 */
export const diskToUrlPathMappingResolver = (pathMapping: PathMapping) => {
  const mapping = Object.entries(pathMapping)
    .filter(([key]) => !!key)
    .sort(([keyA], [keyB]) => keyB.length - keyA.length)
    .map(([key, value]) => [forceForwardSlashes(fixDriveLetter(key)), value] as const);

  if (mapping.length === 0) {
    return () => undefined;
  }

  return (scriptUrlOrPath: string) => {
    if (!path.isAbsolute(scriptUrlOrPath)) {
      return undefined;
    }

    scriptUrlOrPath = forceForwardSlashes(fixDriveLetterAndSlashes(scriptUrlOrPath));

    for (const [pattern, match] of mapping) {
      if (pathMappingPatternMatchesPath(pattern, scriptUrlOrPath)) {
        return { pattern, match, mapped: toClientPath(pattern, match, scriptUrlOrPath) };
      }
    }

    return undefined;
  };
};

/**
 * Applies path mapping to an object like `{ 'C:/Foo': 'D:/bar' }`
 */
export const diskToDiskPathMappingResolver = diskToUrlPathMappingResolver;

/**
 * Applies path mapping to an object like `{ '/foo': 'C:/Foo' }`
 */
export const urlToDiskPathMappingResolver = (pathMapping: PathMapping) => {
  const mapping = Object.entries(pathMapping)
    .filter(([key]) => !!key)
    .sort(([keyA], [keyB]) => keyB.length - keyA.length)
    .map(([key, value]) => [key.startsWith('/') ? key : `/${key}`, value] as const);

  if (mapping.length === 0) {
    return () => undefined;
  }

  return (scriptUrlOrPath: string) => {
    if (!scriptUrlOrPath || !scriptUrlOrPath.startsWith('/')) {
      return undefined;
    }

    for (const [pattern, match] of mapping) {
      if (pathMappingPatternMatchesPath(pattern, scriptUrlOrPath)) {
        return { pattern, match, mapped: toClientPath(pattern, match, scriptUrlOrPath) };
      }
    }

    return undefined;
  };
};

/**
 * A path mapping resolver that resolves to the nearest folder containing
 * a package.json if there's no more precise match in the mapping.
 */
export const moduleAwarePathMappingResolver = (
  fsUtils: IFsUtils,
  compiledPath: string,
  pathMapping: PathMapping,
): PathMappingResolver => {
  const defaultResolver = urlToDiskPathMappingResolver(pathMapping);
  return async sourceRoot => {
    // 1. Handle cases where we know the path is already absolute on disk.
    if (process.platform === 'win32' && /^[a-z]:/i.test(sourceRoot)) {
      return undefined;
    }

    // 2. It's a unix-style path. Get the root of this package containing the compiled file.
    const implicit = await utils.nearestDirectoryContaining(
      fsUtils,
      path.dirname(compiledPath),
      'package.json',
    );

    // 3. If there's no specific root, try to use the base path mappings
    if (!implicit) {
      return defaultResolver(sourceRoot);
    }

    // 4. If we can find a root, only use path mapping from within the package
    const explicit = urlToDiskPathMappingResolver(
      filterObject(pathMapping, key => key.length >= implicit.length),
    )(sourceRoot);

    // 5. On *nix, try at this point to see if the original path given is
    // absolute on-disk. We'll say it is if there was no specific path mapping
    // and the sourceRoot points to a subdirectory that exists.
    if (process.platform !== 'win32' && sourceRoot !== '/' && !explicit) {
      const possibleStat = await fs.stat(sourceRoot).catch(() => undefined);
      if (possibleStat?.isDirectory()) {
        return { mapped: implicit, pattern: sourceRoot, match: sourceRoot };
      }
    }

    // 6. If we got a path mapping within the package, use that. Otherise use
    // the package root as the sourceRoot.
    return explicit || { mapped: implicit, pattern: sourceRoot, match: sourceRoot };
  };
};

function pathMappingPatternMatchesPath(pattern: string, scriptPath: string): boolean {
  if (pattern === scriptPath) {
    return true;
  }

  if (!pattern.endsWith('/')) {
    // Don't match /foo with /foobar/something
    pattern += '/';
  }

  return scriptPath.startsWith(pattern);
}

function toClientPath(pattern: string, mappingRHS: string, scriptPath: string): string {
  const rest = decodeURIComponent(scriptPath.substring(pattern.length));
  const mappedResult = rest ? properJoin(mappingRHS, rest) : mappingRHS;

  return mappedResult;
}

/**
 * Resolves a relative path in terms of another file
 */
function resolveRelativeToFile(absPath: string, relPath: string): string {
  return properResolve(path.dirname(absPath), relPath);
}
