/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { remoteFunction, templateFunction } from './index';
import { ICompletionWithSort, CompletionKind } from '../completions';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Enumerates completion items of the property.
 */
export const enumerateProperties = remoteFunction(function (
  this: unknown,
  target: unknown,
  prefix: string,
  isGlobal: boolean,
) {
  const defaultType = isGlobal ? CompletionKind.Variable : CompletionKind.Property;
  const getCompletionKind = (name: string, dtype: string | undefined, value: unknown) => {
    if (dtype !== 'function') {
      return defaultType;
    }

    if (name === 'constructor') {
      return CompletionKind.Class;
    }

    // Say this value is a class if either it stringifies into a native ES6
    // class declaration, or it's native that starts with a capital letter.
    // No, there's not really a better way to do this.
    // https://stackoverflow.com/questions/30758961/how-to-check-if-a-variable-is-an-es6-class-declaration
    const stringified = String(value);
    if (
      stringified.startsWith('class ') ||
      (stringified.includes('[native code]') && /^[A-Z]/.test(name))
    ) {
      return CompletionKind.Class;
    }

    return isGlobal ? CompletionKind.Function : CompletionKind.Method;
  };

  const result: ICompletionWithSort[] = [];
  const discovered = new Set<string>();
  let sortPrefix = '~';

  // eslint-disable-next-line @typescript-eslint/no-this-alias
  let object = target === undefined ? this : target;
  for (; object != null; object = (object as any).__proto__) {
    sortPrefix += '~';
    const props = Object.getOwnPropertyNames(object).filter(
      l => l.startsWith(prefix) && !l.match(/^\d+$/),
    );

    for (const name of props) {
      if (discovered.has(name)) {
        continue;
      }

      discovered.add(name);
      const descriptor = Object.getOwnPropertyDescriptor(object, name);
      let type = defaultType;
      try {
        type = getCompletionKind(name, typeof descriptor?.value, (object as any)[name]);
      } catch {
        // ignored -- the act of accessing some properties has side effects
        // or can throw errors, fall back to the default type in those cass.
      }

      result.push({
        label: name,
        // Replace leading underscores with `{` (ordered after alphanum) so
        // that 'private' fields get shown last.
        sortText: sortPrefix + name.replace(/^_+/, m => '{'.repeat(m.length)),
        type,
      });
    }

    // After we go through the first level of properties and into the
    // prototype chain, we'll never be in the global scope.
    isGlobal = false;
  }

  return { result, isArray: this instanceof Array };
});

/**
 * Enumerates completion items of a primitive expression.
 */
export const enumeratePropertiesTemplate = templateFunction<[string, string, string]>(
  enumerateProperties.source,
);
