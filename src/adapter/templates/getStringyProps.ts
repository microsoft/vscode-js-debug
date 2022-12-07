/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { remoteFunction } from '.';

/**
 * Gets a mapping of property names with a custom `.toString()` method
 * to their string representations.
 */
export const getStringyProps = remoteFunction(function (this: unknown, maxLength: number) {
  const out: Record<string, string> = {};
  if (typeof this !== 'object' || !this) {
    return out;
  }

  for (const [key, value] of Object.entries(this)) {
    if (typeof value === 'object' && value && !String(value.toString).includes('[native code]')) {
      const str = String(value);
      if (!str.startsWith('[object ')) {
        out[key] = str.length >= maxLength ? str.slice(0, maxLength) + '…' : str;
      }
    }
  }

  return out;
});

export const getToStringIfCustom = remoteFunction(function (this: unknown, maxLength: number) {
  if (typeof this === 'object' && this && !String(this.toString).includes('[native code]')) {
    const str = String(this);
    if (!str.startsWith('[object ')) {
      return str.length >= maxLength ? str.slice(0, maxLength) + '…' : str;
    }
  }
});
