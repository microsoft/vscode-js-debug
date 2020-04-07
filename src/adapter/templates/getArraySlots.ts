/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { remoteFunction } from '.';

/**
 * Returns an object containing array property descriptors for the given
 * range of array indices.
 */
export const getArraySlots = remoteFunction(function (
  this: unknown[],
  start: number,
  count: number,
) {
  const result = {};
  const from = start === -1 ? 0 : start;
  const to = count === -1 ? this.length : start + count;
  for (let i = from; i < to && i < this.length; ++i) {
    const descriptor = Object.getOwnPropertyDescriptor(this, i);
    if (descriptor) {
      Object.defineProperty(result, i, descriptor);
    }
  }

  return result;
});
