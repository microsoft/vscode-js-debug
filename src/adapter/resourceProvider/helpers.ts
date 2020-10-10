/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { OptionsOfTextResponseBody } from 'got/dist/source';

/**
 * Adds a header to the outgoing request.
 */
export const addHeader: (
  options: OptionsOfTextResponseBody,
  key: string,
  value: string,
) => OptionsOfTextResponseBody = (options, key, value) => {
  key = key.toLowerCase();

  const existing = options.headers?.[key];
  return {
    ...options,
    headers: {
      ...options.headers,
      [key]: existing
        ? existing instanceof Array
          ? existing.concat(value)
          : [existing as string, value]
        : value,
    },
  };
};
