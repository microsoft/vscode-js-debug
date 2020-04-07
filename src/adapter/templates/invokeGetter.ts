/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { remoteFunction } from '.';

/**
 * Gets the object property.
 */
export const invokeGetter = remoteFunction(function (
  this: { [key: string]: unknown },
  property: string | number,
) {
  return this[property];
});
