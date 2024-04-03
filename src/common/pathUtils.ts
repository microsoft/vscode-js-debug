/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { randomBytes } from 'crypto';
import execa from 'execa';
import { tmpdir } from 'os';
import * as path from 'path';
import { FsPromises } from '../ioc-extras';
import { EnvironmentVars } from './environmentVars';
import { existsInjected } from './fsUtils';
import { removeNulls } from './objUtils';

/** Platform-specific path for named sockets */
export const namedSocketDirectory = process.platform === 'win32' ? '\\\\.\\pipe\\' : tmpdir();

let pipeCounter = 0;

export const getRandomPipe = () =>
  path.join(
    namedSocketDirectory,
    `node-cdp.${process.pid}-${randomBytes(4).toString('hex')}-${pipeCounter++}.sock`,
  );

function pathExtensions(env: EnvironmentVars) {
  if (process.platform !== 'win32') {
    return [''];
  }

  const pathExts = env.lookup('PATHEXT');
  return pathExts?.split(';') || ['.exe'];
}

/*
 * Lookup the given program on the PATH and return its absolute path on success and undefined otherwise.
 */
export async function findInPath(
  fs: FsPromises,
  program: string,
  env: { [key: string]: string | null | undefined },
): Promise<string | undefined> {
  let locator: string;
  if (process.platform === 'win32') {
    const windir = env['WINDIR'] || 'C:\\Windows';
    locator = path.join(windir, 'System32', 'where.exe');
  } else {
    locator = '/usr/bin/which';
  }

  try {
    if (await existsInjected(fs, locator)) {
      const located = await execa(locator, [program], { env: removeNulls(env) });
      const lines = located.stdout.split(/\r?\n/);

      if (process.platform === 'win32') {
        // return the first path that has a executable extension
        const executableExtensions = String(env['PATHEXT'] || '.exe')
          .toUpperCase()
          .split(';');

        for (const candidate of lines) {
          const ext = path.extname(candidate).toUpperCase();
          if (ext && executableExtensions.includes(ext)) {
            return candidate;
          }
        }
      } else {
        // return the first path
        if (lines.length > 0) {
          return lines[0];
        }
      }
      return undefined;
    } else {
      // do not report failure if 'locator' app doesn't exist
    }
    return program;
  } catch (err) {
    // fall through
  }

  // fail
  return undefined;
}

/*
 * Ensures the program exists, adding its executable as necessary on Windows.
 */
export async function findExecutable(
  fs: FsPromises,
  program: string | undefined,
  env: EnvironmentVars,
): Promise<string | undefined> {
  if (!program) {
    return undefined;
  }

  if (process.platform === 'win32' && !path.extname(program)) {
    for (const extension of pathExtensions(env)) {
      const path = program + extension;
      if (await existsInjected(fs, path)) {
        return path;
      }
    }
  }

  if (await existsInjected(fs, program)) {
    return program;
  }

  return undefined;
}

/**
 * Electron shims us to be able to files from `.asar` files, but
 * these don't actually exist on the filesystem and will
 * cause failures if we think they are.
 */
export const isWithinAsar = (filePath: string) => filePath.includes(`.asar${path.sep}`);

/**
 * Join path segments properly based on whether they appear to be c:/ -style or / style.
 * Note - must check posix first because win32.isAbsolute includes posix.isAbsolute
 */
export function properJoin(...segments: string[]): string {
  if (path.posix.isAbsolute(segments[0])) {
    return forceForwardSlashes(path.posix.join(...segments));
  } else if (path.win32.isAbsolute(segments[0])) {
    return path.win32.join(...segments);
  } else {
    return path.join(...segments);
  }
}

/**
 * Resolves path segments properly based on whether they appear to be c:/ -style or / style.
 */
export function properResolve(...segments: string[]): string {
  if (path.posix.isAbsolute(segments[0])) {
    return path.posix.resolve(...segments);
  } else if (path.win32.isAbsolute(segments[0])) {
    return path.win32.resolve(...segments);
  } else {
    return path.resolve(...segments);
  }
}

/**
 * Resolves path segments properly based on whether they appear to be c:/ -style or / style.
 */
export function properRelative(fromPath: string, toPath: string): string {
  if (path.posix.isAbsolute(fromPath)) {
    return path.posix.relative(fromPath, toPath);
  } else if (path.win32.isAbsolute(fromPath)) {
    return path.win32.relative(fromPath, toPath);
  } else {
    return path.relative(fromPath, toPath);
  }
}

const splitRe = /\/|\\/;
const fileUriPrefix = 'file:///';

const isWindowsFileUri = (aPath: string) =>
  aPath.startsWith(fileUriPrefix) && aPath[fileUriPrefix.length + 1] === ':';

export const properSplit = (path: string) => path.split(splitRe);

export function fixDriveLetter(aPath: string, uppercaseDriveLetter = false): string {
  if (!aPath) return aPath;

  if (isWindowsFileUri(aPath)) {
    const prefixLen = fileUriPrefix.length;
    aPath = fileUriPrefix + aPath[prefixLen].toLowerCase() + aPath.substr(prefixLen + 1);
  } else if (isWindowsPath(aPath)) {
    // If the path starts with a drive letter, ensure lowercase. VS Code uses a lowercase drive letter
    const driveLetter = uppercaseDriveLetter ? aPath[0].toUpperCase() : aPath[0].toLowerCase();
    aPath = driveLetter + aPath.substr(1);
  }

  return aPath;
}

/**
 * Ensure lower case drive letter and \ on Windows
 */
export function fixDriveLetterAndSlashes(aPath: string, uppercaseDriveLetter = false): string {
  if (!aPath) return aPath;

  aPath = fixDriveLetter(aPath, uppercaseDriveLetter);
  if (isWindowsFileUri(aPath)) {
    const prefixLen = fileUriPrefix.length;
    aPath = aPath.substr(0, prefixLen + 1) + aPath.substr(prefixLen + 1).replace(/\//g, '\\');
  } else if (isWindowsPath(aPath)) {
    aPath = aPath.replace(/\//g, '\\');
  }

  return aPath;
}

/**
 * Replace any backslashes with forward slashes
 * blah\something => blah/something
 */
export function forceForwardSlashes(aUrl: string): string {
  return aUrl
    .replace(/\\\//g, '/') // Replace \/ (unnecessarily escaped forward slash)
    .replace(/\\/g, '/');
}

/**
 * Splits the path with the drive letter included with a trailing slash
 * such that path.join, readdir, etc. work on it standalone.
 */
export const splitWithDriveLetter = (inputPath: string) => {
  const parts = inputPath.split(path.sep);
  if (/^[a-z]:$/i.test(parts[0])) {
    parts[0] += path.sep;
  }

  return parts;
};

/**
 * Gets whether the child is a subdirectory of its parent.
 */
export const isSubdirectoryOf = (parent: string, child: string) => {
  const rel = path.relative(parent, child);
  return rel.length && !path.isAbsolute(rel) && !rel.startsWith('..');
};

/**
 * Gets whether the child is a subdirectory of or equivalent its parent.
 */
export const isSubpathOrEqualTo = (parent: string, child: string) => {
  const rel = path.relative(parent, child);
  return !path.isAbsolute(rel) && !rel.startsWith('..');
};

/**
 * Returns whether the path looks like a UNC path.
 */
export const isUncPath = (path: string) => path.startsWith('\\\\');

/**
 * Returns whether the path looks like a Windows path.
 */
export const isWindowsPath = (path: string) => /^[A-Za-z]:/.test(path) || isUncPath(path);
