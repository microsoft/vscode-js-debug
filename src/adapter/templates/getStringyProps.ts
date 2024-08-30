/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { remoteFunction, templateFunction } from '.';

const enum DescriptionSymbols {
  // Our generic symbol
  Generic = 'debug.description',
  // Node.js-specific symbol that is used for some Node types https://nodejs.org/api/util.html#utilinspectcustom
  Node = 'nodejs.util.inspect.custom',

  // Depth for `nodejs.util.inspect.custom`
  Depth = 2,
}

/**
 * Separate function that initializes description symbols. V8 considers
 * Symbol.for as having a "side effect" and would throw if we tried to first
 * use them inside the description functions.
 */
export const getDescriptionSymbols = remoteFunction(function() {
  return [Symbol.for(DescriptionSymbols.Generic), Symbol.for(DescriptionSymbols.Node)];
});

declare const runtimeArgs: [symbol[]];

/**
 * Gets a mapping of property names with a custom `.toString()` method
 * to their string representations.
 */
export const getStringyProps = templateFunction(function(
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

    if (typeof value === 'object' && value) {
      let str: string | undefined;
      for (const sym of runtimeArgs[0]) {
        if (typeof value[sym] !== 'function') {
          continue;
        }
        try {
          str = value[sym](DescriptionSymbols.Depth);
          break;
        } catch {
          // ignored
        }
      }

      if (!str && !String(value.toString).includes('[native code]')) {
        str = String(value);
      }

      if (str && !str.startsWith('[object ')) {
        out[key] = str.length >= maxLength ? str.slice(0, maxLength) + '…' : str;
      }
    }
  }

  return out;
});

export const getToStringIfCustom = templateFunction(function(
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

  if (typeof this === 'object' && this) {
    let str: string | undefined;
    for (
      const sym of [
        Symbol.for(DescriptionSymbols.Generic),
        Symbol.for(DescriptionSymbols.Node),
      ]
    ) {
      if (typeof (this as Record<symbol, (depth?: number) => string>)[sym] !== 'function') {
        continue;
      }
      try {
        str = (this as Record<symbol, (depth?: number) => string>)[sym](DescriptionSymbols.Depth);
        break;
      } catch {
        // ignored
      }
    }

    if (!str && !String(this.toString).includes('[native code]')) {
      str = String(this);
    }

    if (str && !str.startsWith('[object ')) {
      return str.length >= maxLength ? str.slice(0, maxLength) + '…' : str;
    }
  }
});
