/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
import { hash } from '@c4312/chromehash';
import { readFileRaw } from '../fsUtils';

/**
 * Message sent to the hash worker.
 */
export type HashRequest = { id: number; file: string } | { id: number; data: string | Buffer };

/**
 * Message received in the hash response.
 */
export type HashResponse = { id: number; hash?: string };

function startWorker(send: (message: HashResponse) => void) {
  process.on('message', (msg: HashRequest) => {
    if ('file' in msg) {
      const file = msg.file;
      readFileRaw(file)
        .then(data => send({ id: msg.id, hash: hash(data) }))
        .catch(() => send({ id: msg.id }));
    } else if ('data' in msg) {
      send({
        id: msg.id,
        hash: hash(msg.data instanceof Buffer ? msg.data : Buffer.from(msg.data, 'utf-8')),
      });
    }
  });
}

if (process.send) {
  startWorker(process.send.bind(process));
}
