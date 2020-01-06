/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as fs from 'fs';
import * as util from 'util';
const readFileAsync = util.promisify(fs.readFile);

export const fsModule = fs;

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
  return readFileAsync(path).catch(err => Buffer.alloc(0));
}

export function exists(path: string): Promise<boolean> {
  return new Promise(cb => {
    fs.exists(path, cb);
  });
}
