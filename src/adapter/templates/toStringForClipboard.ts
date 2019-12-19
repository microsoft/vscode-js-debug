/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { remoteFunction } from '.';

/**
 * Stringifies the current object for the clipboard.
 */
export const toStringForClipboard = remoteFunction(function(
  this: unknown,
  subtype: string | undefined,
) {
  if (subtype === 'node')
    // a DOM node, but we don't have those typings here.
    return (this as { outerHTML: string }).outerHTML;
  if (subtype && typeof this === 'undefined') return subtype + '';
  try {
    return JSON.stringify(this, null, '  ');
  } catch (e) {
    return '' + this;
  }
});
