/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as path from 'path';
import * as fs from 'fs';
import * as childProcess from 'child_process';
import { removeNulls } from './objUtils';

/*
 * Lookup the given program on the PATH and return its absolute path on success and undefined otherwise.
 */
export function findInPath(
  program: string,
  env: { [key: string]: string | null | undefined },
): string | undefined {
  let locator: string;
  if (process.platform === 'win32') {
    const windir = env['WINDIR'] || 'C:\\Windows';
    locator = path.join(windir, 'System32', 'where.exe');
  } else {
    locator = '/usr/bin/which';
  }

  try {
    if (fs.existsSync(locator)) {
      const lines = childProcess
        .execSync(`${locator} ${program}`, { env: removeNulls(env) })
        .toString()
        .split(/\r?\n/);

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
export function findExecutable(
  program: string | undefined,
  env: { [key: string]: string | null },
): string | undefined {
  if (!program) {
    return undefined;
  }

  if (process.platform === 'win32' && !path.extname(program)) {
    const pathExtension = env['PATHEXT'];
    if (pathExtension) {
      const executableExtensions = pathExtension.split(';');
      for (const extension of executableExtensions) {
        const path = program + extension;
        if (fs.existsSync(path)) {
          return path;
        }
      }
    }
  }

  if (fs.existsSync(program)) {
    return program;
  }

  return undefined;
}

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

export function fixDriveLetter(aPath: string, uppercaseDriveLetter = false): string {
  if (!aPath) return aPath;

  if (aPath.match(/file:\/\/\/[A-Za-z]:/)) {
    const prefixLen = 'file:///'.length;
    aPath = 'file:///' + aPath[prefixLen].toLowerCase() + aPath.substr(prefixLen + 1);
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
  if (aPath.match(/file:\/\/\/[A-Za-z]:/)) {
    const prefixLen = 'file:///'.length;
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
 * Returns whether the path looks like a UNC path.
 */
export const isUncPath = (path: string) => path.startsWith('\\\\');

/**
 * Returns whether the path looks like a Windows path.
 */
export const isWindowsPath = (path: string) => /^[A-Za-z]:/.test(path);
