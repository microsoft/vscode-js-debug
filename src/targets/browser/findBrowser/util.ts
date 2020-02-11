/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { IExecutable, Quality } from './index';
import { canAccess } from '../../../common/fsUtils';
import { win32 } from 'path';
import { FsPromises } from '../../../ioc-extras';

/**
 * Gets the configured Chrome path, if any.
 */
export async function preferredChromePath(
  fs: FsPromises,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  if (await canAccess(fs, env.CHROME_PATH)) {
    return env.CHROME_PATH;
  }
}

/**
 * Gets the configured Edge path, if any.
 */
export async function preferredEdgePath(
  fs: FsPromises,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  if (await canAccess(fs, env.EDGE_PATH)) {
    return env.EDGE_PATH;
  }
}

/**
 * Sorts the set of installations,
 */
export function sort(
  installations: Iterable<string>,
  priorities: { regex: RegExp; weight: number; quality: Quality }[],
): IExecutable[] {
  const defaultPriority = 10;
  return (
    [...installations]
      .filter(inst => !!inst)
      .map(inst => {
        const priority = priorities.find(p => p.regex.test(inst));
        return priority
          ? { path: inst, weight: priority.weight, quality: priority.quality }
          : { path: inst, weight: defaultPriority, quality: Quality.Dev };
      })
      // sort based on weight
      .sort((a, b) => b.weight - a.weight)
      // remove weight
      .map(p => ({ path: p.path, quality: p.quality }))
  );
}

/**
 * Finds binaries for Windows platforms by looking for the given path
 * suffixes in each of the local app data and program files directories
 * on the machine, returning complete absolute paths that match.
 */
export async function findWindowsCandidates(
  env: NodeJS.ProcessEnv,
  fs: FsPromises,
  suffixes: { name: string; type: Quality }[],
) {
  const prefixes = [env.LOCALAPPDATA, env.PROGRAMFILES, env['PROGRAMFILES(X86)']].filter(
    (p): p is string => !!p,
  );

  const todo: Promise<IExecutable | undefined>[] = [];
  for (const prefix of prefixes) {
    for (const suffix of suffixes) {
      const candidate = win32.join(prefix, suffix.name);
      todo.push(
        canAccess(fs, candidate).then(ok =>
          ok ? { path: candidate, quality: suffix.type } : undefined,
        ),
      );
    }
  }

  return (await Promise.all(todo)).filter((e): e is IExecutable => !!e);
}
