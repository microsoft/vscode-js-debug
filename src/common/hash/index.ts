/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { ChildProcess, fork } from 'child_process';
import { join } from 'path';
import { HashRequest, HashResponse } from './hash';
import { debounce } from '../objUtils';

let instance: ChildProcess | undefined;
let messageId = 0;

const cleanup = debounce(30 * 1000, () => {
  instance?.kill();
  instance = undefined;
});

const create = () => {
  if (instance) {
    return instance;
  }

  instance = fork(join(__dirname, 'hash.js'), [], { env: {}, silent: true });
  instance.setMaxListeners(Infinity);
  return instance;
};

const send = (req: HashRequest): Promise<string | undefined> => {
  const cp = create();
  cleanup();

  return new Promise(resolve => {
    const listener = (res: HashResponse) => {
      if (res.id === req.id) {
        resolve(res.hash);
        cp.removeListener('message', listener);
      }
    };

    cp.addListener('message', listener);
    cp.send(req);
  });
};

/**
 * Gets the Chrome content hash of script contents.
 */
export const hashBytes = (data: string | Buffer) => send({ data, id: messageId++ });

/**
 * Gets the Chrome content hash of a file.
 */
export const hashFile = (file: string) => send({ file, id: messageId++ });
