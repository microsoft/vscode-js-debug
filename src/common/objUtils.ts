// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

export const removeNulls = <V>(obj: { [key: string]: V | null }) =>
  filterValues(obj, (v): v is V => v !== null);

export const removeUndefined = <V>(obj: { [key: string]: V | undefined }) =>
  filterValues(obj, (v): v is V => v !== undefined);

/**
 * Filters the object by value.
 */
export function filterValues<V, F extends V>(
  obj: Readonly<{ [key: string]: V }>,
  predicate: (value: V, key: string) => value is F,
): { [key: string]: F } {
  const next: { [key: string]: F } = {};
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    if (predicate(value, key)) {
      next[key] = value;
    }
  }

  return next;
}

/**
 * Maps the object values.
 */
export function mapValues<T, R>(
  obj: Readonly<{ [key: string]: T }>,
  generator: (value: T, key: string) => R,
): { [key: string]: R } {
  const next: { [key: string]: R } = {};
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    next[key] = generator(value, key);
  }

  return next;
}

/**
 * Sorts the object keys using the given sorting function.
 */
export function sortKeys<T>(obj: T, sortFn?: (a: keyof T, b: keyof T) => number): T {
  if (!obj || typeof obj !== 'object' || obj instanceof Array) {
    return obj;
  }

  const next: Partial<T> = {};
  for (const key of (Object.keys(obj) as (keyof T)[]).sort(sortFn)) {
    next[key] = obj[key];
  }

  return next as T;
}

/**
 * Recurively walks over the simple object.
 */
export function walkObject(obj: any, visitor: (value: unknown) => any): any {
  obj = visitor(obj);

  if (obj) {
    if (obj instanceof Array) {
      obj = obj.map(v => walkObject(v, visitor));
    } else if (typeof obj === 'object' && obj) {
      for (const key of Object.keys(obj)) {
        obj[key] = walkObject(obj[key], visitor);
      }
    }
  }

  return obj;
}

/**
 * Performs a case-insenstive merge of the list of objects.
 */
export function caseInsensitiveMerge<V>(
  ...objs: ReadonlyArray<Readonly<{ [key: string]: V }> | undefined | null>
) {
  if (objs.length === 0) {
    return {};
  }

  const out: any = {};
  const caseMapping: { [key: string]: string } = Object.create(null); // prototype-free object
  for (const obj of objs) {
    if (!obj) {
      continue;
    }

    for (const key of Object.keys(obj)) {
      let normalized = key.toLowerCase();
      if (caseMapping[normalized]) {
        out[caseMapping[normalized]] = obj[key];
      } else {
        caseMapping[normalized] = key;
        out[key] = obj[key];
      }
    }
  }

  return out;
}

export function getCaseInsensitiveProperty<R>(
  obj: { [key: string]: R },
  prop: string,
): R | undefined {
  if (obj.hasOwnProperty(prop)) {
    return obj[prop]; // fast path
  }

  const normalized = prop.toLowerCase();
  for (const key of Object.keys(obj)) {
    if (key.toLowerCase() === normalized) {
      return obj[key];
    }
  }

  return undefined;
}
