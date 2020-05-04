/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as fs from 'fs';
import * as util from 'util';
import { FsPromises } from '../ioc-extras';

export const fsModule = fs;

/**
 * Returns whether the user can access the given file path.
 */
export async function canAccess({ access }: FsPromises, file: string | undefined | null) {
  if (!file) {
    return false;
  }

  try {
    await access(file);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Moves the file from the source to destination.
 */
export async function moveFile(
  { copyFile, rename, unlink }: FsPromises,
  src: string,
  dest: string,
) {
  try {
    await rename(src, dest);
  } catch {
    await copyFile(src, dest);
    await unlink(src);
  }
}

export function stat(path: string): Promise<fs.Stats | undefined> {
  return new Promise(cb => {
    fs.stat(path, (err, stat) => {
      return cb(err ? undefined : stat);
    });
  });
}

export function readdir(path: string): Promise<string[]> {
  return new Promise(cb => {
    fs.readdir(path, 'utf8', async (err, entries) => {
      cb(err ? [] : entries);
    });
  });
}

export function readfile(path: string): Promise<string> {
  return new Promise(cb => {
    fs.readFile(path, 'utf8', async (err, content) => {
      cb(err ? '' : content);
    });
  });
}

export const writeFile = util.promisify(fs.writeFile);

export function readFileRaw(path: string): Promise<Buffer> {
  return fs.promises.readFile(path).catch(() => Buffer.alloc(0));
}

export function exists(path: string): Promise<boolean> {
  return new Promise(cb => {
    fs.exists(path, cb);
  });
}
