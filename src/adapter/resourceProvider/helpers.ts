/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { AnyRequestOptions } from './resourceProviderState';

/**
 * Adds a header to the outgoing request.
 */
export const addHeader = (
  options: AnyRequestOptions,
  key: string,
  value: string,
): AnyRequestOptions => {
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
