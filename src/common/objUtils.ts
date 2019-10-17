/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

export function removeNulls<R>(obj: { [key: string]: R | null }) {
  const next: { [key: string]: R } = {};
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    if (value !== null) {
      next[key] = value;
    }
  }

  return next;
}
