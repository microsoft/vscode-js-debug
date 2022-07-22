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
    if (
      typeof value === 'object' &&
      value &&
      !String(value.toString).includes('[native code]') &&
      !String(this).includes('[object ')
    ) {
      out[key] = String(value).slice(0, maxLength);
    }
  }

  return out;
});

export const getToStringIfCustom = remoteFunction(function (this: unknown, maxLength: number) {
  if (
    typeof this === 'object' &&
    this &&
    !String(this.toString).includes('[native code]') &&
    !String(this).includes('[object ')
  ) {
    return String(this).slice(0, maxLength);
  }
});
