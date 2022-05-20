/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { Headers, OptionsOfTextResponseBody } from 'got';

/**
 * Adds a header to the outgoing request.
 */
export const addHeader: (headers: Headers, key: string, value: string) => Headers = (
  options,
  key,
  value,
) => {
  key = key.toLowerCase();

  const existing = options?.[key];
  return {
    ...options,
    [key]: existing
      ? existing instanceof Array
        ? existing.concat(value)
        : [existing as string, value]
      : value,
  };
};

export const mergeOptions = (
  into: OptionsOfTextResponseBody,
  from: Partial<OptionsOfTextResponseBody>,
) => {
  const cast = into as Record<string, unknown>;
  for (const [key, value] of Object.entries(from)) {
    if (typeof value === 'object' && !!value) {
      cast[key] = Object.assign((cast[key] || {}) as Record<string, unknown>, value);
    } else {
      cast[key] = value;
    }
  }
};
