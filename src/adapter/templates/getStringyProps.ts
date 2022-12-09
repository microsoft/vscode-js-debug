/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { templateFunction } from '.';

/**
 * Gets a mapping of property names with a custom `.toString()` method
 * to their string representations.
 */
export const getStringyProps = templateFunction(function (
  this: unknown,
  maxLength: number,
  customToString: (defaultRepr: string) => unknown,
) {
  const out: Record<string, string> = {};
  const defaultPlaceholder = '<<default preview>>';
  if (typeof this !== 'object' || !this) {
    return out;
  }

  for (const [key, value] of Object.entries(this)) {
    if (customToString) {
      try {
        const repr = customToString.call(value, defaultPlaceholder);
        if (repr !== defaultPlaceholder) {
          out[key] = String(repr);
          continue;
        }
      } catch (e) {
        out[key] = `<<indescribable>>${JSON.stringify([String(e), key])}`;
        continue;
      }
    }

    if (typeof value === 'object' && value && !String(value.toString).includes('[native code]')) {
      const str = String(value);
      if (!str.startsWith('[object ')) {
        out[key] = str.length >= maxLength ? str.slice(0, maxLength) + '…' : str;
        continue;
      }
    }
  }

  return out;
});

export const getToStringIfCustom = templateFunction(function (
  this: unknown,
  maxLength: number,
  customToString: (defaultRepr: string) => unknown,
) {
  if (customToString) {
    try {
      const defaultPlaceholder = '<<default preview>>';
      const repr = customToString.call(this, defaultPlaceholder);
      if (repr !== defaultPlaceholder) {
        return String(repr);
      }
    } catch (e) {
      return `<<indescribable>>${JSON.stringify([String(e), 'object'])}`;
    }
  }

  if (typeof this === 'object' && this && !String(this.toString).includes('[native code]')) {
    const str = String(this);
    if (!str.startsWith('[object ')) {
      return str.length >= maxLength ? str.slice(0, maxLength) + '…' : str;
    }
  }
});
