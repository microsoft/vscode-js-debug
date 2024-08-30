/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { promises as fsPromises } from 'fs';
import { LocalFsUtils } from '../fsUtils';
import { isWithinAsar } from '../pathUtils';
import { Hasher } from '.';

const hasher = new Hasher();

export async function checkContentHash(
  absolutePath: string,
  contentHash?: string,
  contentOverride?: string,
): Promise<string | undefined> {
  if (!absolutePath) {
    return undefined;
  }

  if (isWithinAsar(absolutePath)) {
    return undefined;
  }

  if (!contentHash) {
    const exists = await new LocalFsUtils(fsPromises).exists(absolutePath);
    return exists ? absolutePath : undefined;
  }

  const result = typeof contentOverride === 'string'
    ? await hasher.verifyBytes(contentOverride, contentHash, true)
    : await hasher.verifyFile(absolutePath, contentHash, true);

  return result ? absolutePath : undefined;
}
