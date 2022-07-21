/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

export function asArray<T>(thing: T | ReadonlyArray<T>): T[] {
  if (Array.isArray(thing)) {
    return thing;
  } else {
    return [thing as T];
  }
}
