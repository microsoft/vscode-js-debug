/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import { EOL, tmpdir } from 'os';
import * as path from 'path';
import { join } from 'path';
import { IFileTree } from './test';

export const getTestDir = () => join(tmpdir(), 'js-debug-test-' + randomBytes(6).toString('hex'));

/**
 * Creates a file tree at the given location. Primarily useful for creating
 * fixtures in unit tests.
 */
export function createFileTree(rootDir: string, tree: IFileTree) {
  fs.mkdirSync(rootDir, { recursive: true });

  for (const key of Object.keys(tree)) {
    const value = tree[key];
    const targetPath = path.join(rootDir, key);

    let write: Buffer;
    if (typeof value === 'string') {
      write = Buffer.from(value);
    } else if (value instanceof Buffer) {
      write = value;
    } else if (value instanceof Array) {
      write = Buffer.from(value.join(EOL));
    } else {
      createFileTree(targetPath, value);
      continue;
    }

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, write);
  }
}
