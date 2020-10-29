/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { Headers } from 'got';

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
