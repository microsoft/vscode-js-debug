/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { ChildProcess, fork } from 'child_process';
import { join } from 'path';
import { HashRequest, HashResponse, MessageType } from './hash';
import { debounce } from '../objUtils';
import { IDeferred, getDeferred } from '../promiseUtil';

let instance: ChildProcess | undefined;
let instanceFailureCount = 0;
const MaximumRetriesForFailure = 3;
let messageId = 0;
const deferredMap: {
  [id: number]: { deferred: IDeferred<HashResponse<HashRequest>> | undefined; request: {} };
} = {};

const deferCleanup = debounce(30 * 1000, () => {
  instance?.kill();
  instance = undefined;
  instanceFailureCount = 0;
});

const create = () => {
  if (instance) {
    return instance;
  }

  instance = fork(join(__dirname, 'hash.bundle.js'), [], { env: {}, silent: true, execArgv: [] });
  instance.setMaxListeners(Infinity);
  instance.addListener('message', raw => {
    const msg = raw as HashResponse<HashRequest>;
    const deferred = deferredMap[msg.id].deferred;
    delete deferredMap[msg.id];
    deferred?.resolve(msg);
  });

  instance.on('exit', () => {
    const isRetrying = instanceFailureCount++ <= MaximumRetriesForFailure;
    if (isRetrying) {
      instance = undefined;
      create();
      deferCleanup();
    }

    Object.keys(deferredMap).forEach(msgId => {
      const { deferred, request } = deferredMap[msgId];
      if (isRetrying) {
        instance?.send(request);
      } else {
        delete deferredMap[msgId];
        deferred?.reject(new Error('hash.bundle.js process unexpectedly exited'));
      }
    });
  });

  return instance;
};

const send = <T extends HashRequest>(req: T): Promise<HashResponse<T>> => {
  const cp = create();
  deferCleanup();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const deferred = getDeferred<any>();
  deferredMap[req.id] = { deferred, request: req };
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
