/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { makeInternalSourceUrl, templateFunction } from '.';

/* eslint-disable @typescript-eslint/no-explicit-any */

export const breakOnWasmSourceUrl = makeInternalSourceUrl(); // randomized

export const breakOnWasmInit = templateFunction(function() {
  // Track modules already seen in this execution context so instantiating a
  // precompiled WebAssembly.Module (e.g. received in a worker via postMessage)
  // still pauses the first time while avoiding redundant pauses on repeats.
  const seenModules = new WeakSet<WebAssembly.Module>();
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
        const mod = args[0] instanceof WebAssembly.Module
          ? args[0]
          : r instanceof WebAssembly.Module
          ? r
          : r && typeof r === 'object'
          ? (r as { module?: unknown }).module
          : undefined;
        if (!(mod instanceof WebAssembly.Module) || !seenModules.has(mod)) {
          if (mod instanceof WebAssembly.Module) {
            seenModules.add(mod);
          }
          debugger;
        }
        return r as any;
      });
    };
  }
}, breakOnWasmSourceUrl);
