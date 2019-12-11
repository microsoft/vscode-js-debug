/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
import Long from 'long';

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
    let v = 0;
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
