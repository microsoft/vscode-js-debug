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
        // note: instantiating an existing module won't (re)compile the script
        // so we have no need to stop.
        if (!(args[0] instanceof WebAssembly.Module)) {
          debugger;
        }
        return r as any;
      });
    };
  }
}, breakOnWasmSourceUrl);
