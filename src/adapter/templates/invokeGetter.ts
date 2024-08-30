/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { remoteFunction } from '.';

/**
 * Gets the object property.
 */
export const invokeGetter = remoteFunction(function(
  this: unknown,
  getterFn: (this: unknown) => unknown,
) {
  return getterFn.call(this);
});
