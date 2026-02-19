/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { remoteFunction, templateFunction } from '.';

export const enum DescriptionSymbols {
  // Our generic symbol
  Generic = 'debug.description',
  // Node.js-specific symbol that is used for some Node types https://nodejs.org/api/util.html#utilinspectcustom
  Node = 'nodejs.util.inspect.custom',
  // Symbol for custom property replacement
  Properties = 'debug.properties',

  // Depth for `nodejs.util.inspect.custom`
  Depth = 2,
}

/**
 * Separate function that initializes description symbols. V8 considers
 * Symbol.for as having a "side effect" and would throw if we tried to first
 * use them inside the description functions.
 */
export const getDescriptionSymbols = remoteFunction(function() {
  return [
    Symbol.for(DescriptionSymbols.Generic),
    Symbol.for(DescriptionSymbols.Node),
    Symbol.for(DescriptionSymbols.Properties),
  ];
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
  let customProps = false;
  const out: Record<string, string> = {};
  const defaultPlaceholder = '<<default preview>>';
  if (typeof this !== 'object' || !this) {
    return out;
  }

  for (const key of Object.keys(this)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let value: any;
    try {
      value = this[key];
    } catch (e) {
      continue;
    }
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
      for (const sym of runtimeArgs[0].slice(0, 2)) {
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

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    customProps = typeof (this as any)[runtimeArgs[0][2]] === 'function';
  } catch {
    // ignored
  }

  return { out, customProps };
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

/**
 * Checks if the object has a custom properties function via Symbol.for("debug.properties")
 * and returns the replacement object if it does. Returns undefined otherwise.
 * The symbols array is passed via runtimeArgs[0], with properties symbol at index 2.
 */
export const getCustomProperties = templateFunction(function(this: unknown) {
  const propertiesSymbol: symbol = (runtimeArgs as unknown as [symbol[]])[0][2];

  if (typeof this !== 'object' || !this) {
    return undefined;
  }

  // Check if the object has the debug.properties symbol
  if (typeof (this as Record<symbol, () => unknown>)[propertiesSymbol] !== 'function') {
    return undefined;
  }

  try {
    const result = (this as Record<symbol, () => unknown>)[propertiesSymbol]();
    // Only return if we got a valid object back
    if (typeof result === 'object' && result !== null) {
      return result;
    }
  } catch {
    // If the function throws, we'll just return undefined and use default properties
  }

  return undefined;
});
