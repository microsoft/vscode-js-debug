/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

export function asArray<T>(thing: T | readonly T[]): readonly T[] {
  return thing instanceof Array ? thing : [thing];
}
