/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import Dap from '../../dap/api';
import { templateFunction } from './index';
import { CompletionKind } from '../completions';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Enumerates completion items of the property.
 */
export const enumeratePropertiesTemplate = templateFunction(
  (expression: unknown, prefix: string, isGlobal: boolean) => {
    const getCompletionKind = (name: string, dtype: string | undefined, value: unknown) => {
      if (dtype !== 'function') {
        return isGlobal ? CompletionKind.Variable : CompletionKind.Property;
      }

      // Say this value is a class if either it stringifies into a native ES6
      // class declaration, or it's native that starts with a capital letter.
      // No, there's not really a better way to do this.
      // https://stackoverflow.com/questions/30758961/how-to-check-if-a-variable-is-an-es6-class-declaration
      const stringified = String(value);
      if (
        stringified.startsWith('class ') ||
        (stringified.includes('[native code]') && name[0].toUpperCase() === name[0])
      ) {
        return CompletionKind.Class;
      }

      return isGlobal ? CompletionKind.Function : CompletionKind.Method;
    };

    const result: Dap.CompletionItem[] = [];
    const discovered = new Set<string>();
    let sortPrefix = '~';

    for (let object = expression; object != null; object = (object as any).__proto__) {
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
        result.push({
          label: name,
          sortText: sortPrefix + name,
          type: getCompletionKind(name, typeof descriptor?.value, (object as any)[name]),
        });
      }

      // After we go through the first level of properties and into the
      // prototype chain, we'll never be in the global scope.
      isGlobal = false;
    }

    return { result, isArray: expression instanceof Array };
  },
);
