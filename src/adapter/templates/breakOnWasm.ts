/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { makeInternalSourceUrl, templateFunction } from '.';

/* eslint-disable @typescript-eslint/no-explicit-any */

export const breakOnWasmSourceUrl = makeInternalSourceUrl(); // randomized

export const breakOnWasmInit = templateFunction(function() {
  const fns = [
    'instantiate',
    'instantiateStreaming',
    'compile',
    'compileStreaming',
  ] satisfies (keyof typeof WebAssembly)[];
  for (const fn of fns) {
    const original = (WebAssembly as any)[fn];
    WebAssembly[fn] = function(...args) {
      return original.apply(this, args).then((r: unknown) => {
        debugger;
        return r as any;
      });
    };
  }
}, breakOnWasmSourceUrl);
