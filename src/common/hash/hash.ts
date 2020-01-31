/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
import Long from 'long';
import { readFileRaw } from '../fsUtils';

/**
 * An implementation of the Chrome content hashing algorithm used to verify
 * whether files on disk are the same as those in the debug session.
 */
export function calculateHash(input: Buffer): string {
  const prime = [
    new Long(0x3fb75161, 0, true),
    new Long(0xab1f4e4f, 0, true),
    new Long(0x82675bc5, 0, true),
    new Long(0xcd924d35, 0, true),
    new Long(0x81abe279, 0, true),
  ];
  const random = [
    new Long(0x67452301, 0, true),
    new Long(0xefcdab89, 0, true),
    new Long(0x98badcfe, 0, true),
    new Long(0x10325476, 0, true),
    new Long(0xc3d2e1f0, 0, true),
  ];
  const randomOdd = [
    new Long(0xb4663807, 0, true),
    new Long(0xcc322bf5, 0, true),
    new Long(0xd4f91bbd, 0, true),
    new Long(0xa7bea11d, 0, true),
    new Long(0x8f462907, 0, true),
  ];

  const hashes = [
    new Long(0, 0, true),
    new Long(0, 0, true),
    new Long(0, 0, true),
    new Long(0, 0, true),
    new Long(0, 0, true),
  ];
  const zi = [
    new Long(1, 0, true),
    new Long(1, 0, true),
    new Long(1, 0, true),
    new Long(1, 0, true),
    new Long(1, 0, true),
  ];
  const k0x7FFFFFFF = new Long(0x7fffffff);

  const buffer = normalize(input);
  const inc = 4;

  // First pass reads 4 bytes at a time
  let current = 0;
  for (let i = 0; i < buffer.byteLength - (buffer.byteLength % inc); i += inc) {
    const d = buffer.readUInt32LE(i);
    const v = d;

    const xi = new Long(v).mul(randomOdd[current]).and(k0x7FFFFFFF);
    hashes[current] = hashes[current].add(zi[current].mul(xi)).mod(prime[current]);
    zi[current] = zi[current].mul(random[current]).mod(prime[current]);
    current = current === hashes.length - 1 ? 0 : current + 1;
  }

  // If we have an odd number of bytes, calculate the rest of the hash
  if (buffer.byteLength % inc) {
    let v = 0; // in c++ this is a uint32, but since we only use the first 24 bits it's OK to have it as a normal JS number
    for (let i = buffer.byteLength - (buffer.byteLength % inc); i < buffer.byteLength; ++i) {
      v <<= 8;
      v |= buffer.readUInt8(i);
    }
    const xi = new Long(v).mul(randomOdd[current]).and(k0x7FFFFFFF);
    hashes[current] = hashes[current].add(zi[current].mul(xi)).mod(prime[current]);
    zi[current] = zi[current].mul(random[current]).mod(prime[current]);
    current = current === hashes.length - 1 ? 0 : current + 1;
  }

  for (let i = 0; i < hashes.length; ++i) {
    hashes[i] = hashes[i].add(zi[i].mul(prime[i].sub(1))).mod(prime[i]);
  }

  let hash = '';
  for (let i = 0; i < hashes.length; ++i) {
    hash += hashes[i].toString(16).padStart(8, '0');
  }
  return hash;
}

const hasUTF8BOM = (buffer: Buffer) =>
  buffer.byteLength >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
const hasUtf16LEBOM = (buffer: Buffer) =>
  buffer.byteLength >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe;
const hasUtf16BEBOM = (buffer: Buffer) =>
  buffer.byteLength >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff;

function normalize(buffer: Buffer): Buffer {
  if (hasUTF8BOM(buffer)) return normalize(buffer.slice(3));
  if (hasUtf16LEBOM(buffer)) return buffer.slice(2);
  if (hasUtf16BEBOM(buffer)) return buffer.slice(2).swap16();
  // if no byte order mark, assume it's utf8
  return utf8ToUtf16(buffer);
}

function utf8ToUtf16(buffer: Buffer) {
  return Buffer.from(buffer.toString('utf8'), 'utf16le');
}

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

const verifyBytes = (bytes: Buffer, expected: string, checkNode: boolean) => {
  if (calculateHash(bytes) === expected) {
    return true;
  }

  if (checkNode && calculateHash(Buffer.concat([nodePrefix, bytes, nodeSuffix])) === expected) {
    return true;
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
        return { id: message.id, hash: calculateHash(data) };
      } catch (e) {
        return { id: message.id };
      }
    case MessageType.HashBytes:
      try {
        return { id: message.id, hash: calculateHash(toBuffer(message.data)) };
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
