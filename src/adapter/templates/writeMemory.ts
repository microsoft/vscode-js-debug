/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { remoteFunction } from '.';

/**
 * Writes memory from a binary type. Takes a hex encoded string.
 */
export const writeMemory = remoteFunction(function(
  this: DataView | TypedArray | ArrayBuffer | WebAssembly.Memory,
  offset: number,
  data: string,
) {
  const bytes = decodeHex(data);

  const { buffer, byteLength, byteOffset } = this instanceof ArrayBuffer
    ? new DataView(this)
    : this instanceof WebAssembly.Memory
    ? new DataView(this.buffer)
    : this;

  const writeStart = byteOffset + Math.min(offset, byteLength);
  const writeLen = Math.max(0, Math.min(bytes.length, byteLength - offset));
  new Uint8Array(buffer, writeStart, writeLen).set(bytes.subarray(0, writeLen));

  return writeLen;

  function decodeHex(str: string) {
    const output = new Uint8Array(str.length >>> 1);
    for (let i = 0; i < str.length; i += 2) {
      output[i >>> 1] = parseInt(str.slice(i, i + 2), 16);
    }

    return output;
  }
});
