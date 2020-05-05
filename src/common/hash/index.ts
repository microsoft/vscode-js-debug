/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { ChildProcess, fork } from 'child_process';
import { join } from 'path';
import { HashRequest, HashResponse, MessageType } from './hash';
import { debounce } from '../objUtils';
import { IDeferred, getDeferred } from '../promiseUtil';

let instance: ChildProcess | undefined;
let messageId = 0;
const deferredMap: { [id: number]: IDeferred<HashResponse<HashRequest>> | undefined } = {};

const deferCleanup = debounce(30 * 1000, () => {
  instance?.kill();
  instance = undefined;
});

const create = () => {
  if (instance) {
    return instance;
  }

  instance = fork(join(__dirname, 'hash.bundle.js'), [], { env: {}, silent: true, execArgv: [] });
  instance.setMaxListeners(Infinity);
  instance.addListener('message', raw => {
    const msg = raw as HashResponse<HashRequest>;
    const deferred = deferredMap[msg.id];
    delete deferredMap[msg.id];
    deferred?.resolve(msg);
  });

  return instance;
};

const send = <T extends HashRequest>(req: T): Promise<HashResponse<T>> => {
  const cp = create();
  deferCleanup();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const deferred = getDeferred<any>();
  deferredMap[req.id] = deferred;
  cp.send(req);

  return deferred.promise;
};

/**
 * Gets the Chrome content hash of script contents.
 */
export const hashBytes = async (data: string | Buffer) =>
  (await send({ type: MessageType.HashBytes, data, id: messageId++ })).hash;

/**
 * Gets the Chrome content hash of a file.
 */
export const hashFile = async (file: string) =>
  (await send({ type: MessageType.HashFile, file, id: messageId++ })).hash;

/**
 * Gets the Chrome content hash of script contents.
 */
export const verifyBytes = async (data: string | Buffer, expected: string, checkNode: boolean) =>
  (await send({ type: MessageType.VerifyBytes, data, id: messageId++, expected, checkNode }))
    .matches;

/**
 * Gets the Chrome content hash of a file.
 */
export const verifyFile = async (file: string, expected: string, checkNode: boolean) =>
  (await send({ type: MessageType.VerifyFile, file, id: messageId++, expected, checkNode }))
    .matches;
