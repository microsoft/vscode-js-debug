/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
import { hash } from '@c4312/chromehash';
import { readFileRaw } from '../fsUtils';

export const enum MessageType {
  HashFile,
  HashBytes,
  VerifyFile,
  VerifyBytes,
}

/**
 * Message sent to the hash worker.
 */
export type HashRequest =
  | { type: MessageType.HashFile; id: number; file: string }
  | { type: MessageType.HashBytes; id: number; data: string | Buffer }
  | { type: MessageType.VerifyFile; id: number; file: string; expected: string; checkNode: boolean }
  | {
      type: MessageType.VerifyBytes;
      id: number;
      data: string | Buffer;
      expected: string;
      checkNode: boolean;
    };

/**
 * Message received in the hash response.
 */
export type HashResponse<T extends HashRequest> = T extends {
  type: MessageType.HashBytes | MessageType.HashFile;
}
  ? { id: number; hash?: string }
  : { id: number; matches: boolean };

/**
 * Script loaded though _sometimes_ include the Node.js module wrapper code.
 * Sometimes they don't. If we're in Node, for content hashing try both
 * the wrapped an unwrapped version of the file if necessary.
 *
 * @see https://nodejs.org/api/modules.html#modules_the_module_wrapper
 */
const nodePrefix = Buffer.from('(function (exports, require, module, __filename, __dirname) { ');
const nodeSuffix = Buffer.from('\n});');

/**
 * Node scripts starting with a shebang also have that stripped out.
 */
const shebangPrefix = Buffer.from('#!');

const CR = Buffer.from('\r')[0];
const LF = Buffer.from('\n')[0];

const hasPrefix = (buf: Buffer, prefix: Buffer) => buf.slice(0, prefix.length).equals(prefix);

const verifyBytes = (bytes: Buffer, expected: string, checkNode: boolean) => {
  if (hash(bytes) === expected) {
    return true;
  }

  if (checkNode) {
    if (hasPrefix(bytes, shebangPrefix)) {
      let end = bytes.indexOf(LF);
      if (bytes[end - 1] === CR) {
        // CRLF
        end--;
      }

      return hash(bytes.slice(end)) === expected;
    }

    if (hash(Buffer.concat([nodePrefix, bytes, nodeSuffix])) === expected) {
      return true;
    }
  }

  return false;
};

const toBuffer = (input: string | Buffer) =>
  input instanceof Buffer ? input : Buffer.from(input, 'utf-8');

async function handle(message: HashRequest): Promise<HashResponse<HashRequest>> {
  switch (message.type) {
    case MessageType.HashFile:
      try {
        const data = await readFileRaw(message.file);
        return { id: message.id, hash: hash(data) };
      } catch (e) {
        return { id: message.id };
      }
    case MessageType.HashBytes:
      try {
        return { id: message.id, hash: hash(toBuffer(message.data)) };
      } catch (e) {
        return { id: message.id };
      }
    case MessageType.VerifyFile:
      try {
        const data = await readFileRaw(message.file);
        return { id: message.id, matches: verifyBytes(data, message.expected, message.checkNode) };
      } catch (e) {
        return { id: message.id, matches: false };
      }
    case MessageType.VerifyBytes:
      try {
        return {
          id: message.id,
          matches: verifyBytes(toBuffer(message.data), message.expected, message.checkNode),
        };
      } catch (e) {
        return { id: message.id, matches: false };
      }
  }
}

function startWorker(send: (message: HashResponse<HashRequest>) => void) {
  process.on('message', (msg: HashRequest) => {
    handle(msg).then(send);
  });
}

if (process.send) {
  startWorker(process.send.bind(process));
}
