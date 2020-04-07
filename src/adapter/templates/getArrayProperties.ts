/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { remoteFunction } from '.';

/**
 * Returns non-indexed properties of the array.
 */
export const getArrayProperties = remoteFunction(function (this: unknown[]) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = { __proto__: (this as any).__proto__ };
  const names = Object.getOwnPropertyNames(this);
  for (let i = 0; i < names.length; ++i) {
    const name = names[i];
    const numeric = ((name as unknown) as number) >>> 0;
    // Array index check according to the ES5-15.4.
    if (String(numeric >>> 0) === name && numeric >>> 0 !== 0xffffffff) {
      continue;
    }

    const descriptor = Object.getOwnPropertyDescriptor(this, name);
    if (descriptor) {
      Object.defineProperty(result, name, descriptor);
    }
  }
  return result;
});
