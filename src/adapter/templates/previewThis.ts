/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { remoteFunction } from '.';

/**
 * Returns a preview of the current context.
 */
export const previewThis = remoteFunction(function (this: unknown) {
  return this;
});
