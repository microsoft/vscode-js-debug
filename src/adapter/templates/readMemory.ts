/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { remoteFunction } from '.';

/**
 * Reads memory from a binary type. Returns a hex encoded string.
 */
export const readMemory = remoteFunction(function (
  this: DataView | TypedArray | ArrayBuffer | WebAssembly.Memory,
  start: number,
  count: number,
) {
  const buffer: ArrayBuffer = this instanceof ArrayBuffer ? this : this.buffer;
  const len = buffer.byteLength;
  const subarray = buffer.slice(Math.min(start, len), Math.min(start + count, len));

  return encodeHex(new Uint8Array(subarray));

  function encodeHex(buffer: Uint8Array) {
    const dictionary = '0123456789abcedf';
    let output = '';
    for (let i = 0; i < buffer.length; i++) {
      const b = buffer[i];
      output += dictionary[b >>> 4] + dictionary[b & 0b1111];
    }
    return output;
  }
});
