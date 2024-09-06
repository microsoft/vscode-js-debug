/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { remoteFunction } from '.';

/**
 * Returns an object containing array property descriptors for the given
 * range of array indices.
 */
export const getNodeChildren = remoteFunction(function(
  this: Node,
  start: number,
  count: number,
) {
  const result: Record<number, Node | string> = {};
  const from = start === -1 ? 0 : start;
  const to = count === -1 ? this.childNodes.length : start + count;
  for (let i = from; i < to && i < this.childNodes.length; ++i) {
    const cn = this.childNodes[i];
    if (cn.nodeName === '#comment') {
      result[i] = `<!-- ${cn.textContent} -->`;
    } else if (cn.nodeName === '#text') {
      result[i] = cn.textContent || '';
    } else {
      result[i] = cn;
    }
  }

  return result;
});
