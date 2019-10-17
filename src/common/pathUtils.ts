import * as path from 'path';
import * as fs from 'fs';
import * as childProcess from 'child_process';
import { removeNulls } from './objUtils';

/*
 * Lookup the given program on the PATH and return its absolute path on success and undefined otherwise.
 */
export function findInPath(
  program: string,
  env: { [key: string]: string | null },
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
        const executableExtensions = String(env['PATHEXT']).toUpperCase();
        for (const candidate of lines) {
          const ext = path.extname(candidate).toUpperCase();
          if (ext && executableExtensions.indexOf(ext + ';') > 0) {
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
export function findExecutable(program: string | undefined, env: { [key: string]: string | null }): string | undefined {
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
