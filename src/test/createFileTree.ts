import { randomBytes } from 'crypto';
/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
import * as fs from 'fs';
import * as mkdirp from 'mkdirp';
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
  mkdirp.sync(rootDir);

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

    mkdirp.sync(path.dirname(targetPath));
    fs.writeFileSync(targetPath, write);
  }
}
