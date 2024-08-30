/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { remoteFunction } from '.';

/**
 * Reads memory from a binary type. Returns a hex encoded string.
 */
export const readMemory = remoteFunction(function(
  this: DataView | TypedArray | ArrayBuffer | WebAssembly.Memory,
  start: number,
  count: number,
) {
  const { buffer, byteLength, byteOffset } = this instanceof ArrayBuffer
    ? new DataView(this)
    : this instanceof WebAssembly.Memory
    ? new DataView(this.buffer)
    : this;

  const readStart = byteOffset + Math.min(start, byteLength);
  const readCount = Math.max(0, Math.min(count, byteLength - start));
  return encodeHex(new Uint8Array(buffer, readStart, readCount));

  function encodeHex(buffer: Uint8Array) {
    const dictionary = '0123456789abcdef';
    let output = '';
    for (let i = 0; i < buffer.length; i++) {
      const b = buffer[i];
      output += dictionary[b >>> 4] + dictionary[b & 0b1111];
    }
    return output;
  }
});
