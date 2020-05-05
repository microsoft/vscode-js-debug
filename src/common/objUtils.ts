/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

export const removeNulls = <V>(obj: { [key: string]: V | null }) =>
  filterValues(obj, (v): v is V => v !== null);

export const removeUndefined = <V>(obj: { [key: string]: V | undefined }) =>
  filterValues(obj, (v): v is V => v !== undefined);

/**
 * Asserts that the value is never. If this function is reached, it throws.
 */
export const assertNever = (value: never, message: string): never => {
  debugger;
  throw new Error(message.replace('{value}', JSON.stringify(value)));
};

/**
 * Filters the object by value.
 */
export function filterValues<V, F extends V>(
  obj: Readonly<{ [key: string]: V }>,
  predicate: (value: V, key: string) => value is F,
): { [key: string]: F };
export function filterValues<V>(
  obj: Readonly<{ [key: string]: V }>,
  predicate: (value: V, key: string) => boolean,
): { [key: string]: V };
export function filterValues<V>(
  obj: Readonly<{ [key: string]: V }>,
  predicate: (value: V, key: string) => boolean,
): { [key: string]: V } {
  const next: { [key: string]: V } = {};
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
 * Maps the object keys.
 */
export function mapKeys<T>(
  obj: Readonly<{ [key: string]: T }>,
  generator: (key: string, value: T) => string | void,
): { [key: string]: T } {
  const next: { [key: string]: T } = {};
  for (const key of Object.keys(obj)) {
    const newKey = generator(key, obj[key]);
    if (newKey !== undefined) {
      next[newKey] = obj[key];
    }
  }

  return next;
}

/**
 * Filters the object to the key-value pairs where the predicate returns true.
 */
export function filterObject<T>(
  obj: Readonly<{ [key: string]: T }>,
  predicate: (key: string, value: T) => boolean,
): { [key: string]: T } {
  const next: { [key: string]: T } = {};
  for (const key of Object.keys(obj)) {
    if (predicate(key, obj[key])) {
      next[key] = obj[key];
    }
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
  for (const key of Object.keys(obj).sort(sortFn)) {
    next[key] = obj[key];
  }

  return next as T;
}

/**
 * Recurively walks over the simple object.
 */
// eslint-disable-next-line
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

  const out: { [key: string]: V } = {};
  const caseMapping: { [key: string]: string } = Object.create(null); // prototype-free object
  for (const obj of objs) {
    if (!obj) {
      continue;
    }

    for (const key of Object.keys(obj)) {
      const normalized = key.toLowerCase();
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

/**
 * Does a case-insensitive lookup on the given object.
 */
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

const unset = Symbol('unset');

/**
 * Wraps a function so that it's called once, and never again, memoizing
 * the result.
 */
export function once<T, Args extends unknown[]>(
  fn: (...args: Args) => T,
): ((...args: Args) => T) & { value?: T; forget(): void } {
  let value: T | typeof unset = unset;
  const onced = (...args: Args) => {
    if (value === unset) {
      onced.value = value = fn(...args);
    }

    return value;
  };

  onced.forget = () => {
    value = unset;
    onced.value = undefined;
  };

  onced.value = undefined as T | undefined;

  return onced;
}

/**
 * Memoizes the single-parameter function.
 */
export function memoize<T, R>(fn: (arg: T) => R): ((arg: T) => R) & { clear(): void } {
  const cached = new Map<T, R>();
  const wrapper = (arg: T): R => {
    if (cached.has(arg)) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      return cached.get(arg)!;
    }

    const value = fn(arg);
    cached.set(arg, value);
    return value;
  };

  wrapper.clear = () => cached.clear();

  return wrapper;
}

/**
 * Debounces the function call for an interval.
 */
export function debounce(duration: number, fn: () => void): (() => void) & { clear: () => void } {
  let timeout: NodeJS.Timer | void;
  const debounced = () => {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }

    timeout = setTimeout(() => {
      timeout = undefined;
      fn();
    }, duration);
  };

  debounced.clear = () => {
    if (timeout) {
      clearTimeout(timeout);
      timeout = undefined;
    }
  };

  return debounced;
}

/**
 * Bisets the array by the predicate. The first return value will be the ones
 * in which the predicate returned true, the second where it returned false.
 */
export function bisectArray<T>(
  items: ReadonlyArray<T>,
  predicate: (item: T) => boolean,
): [T[], T[]] {
  const a: T[] = [];
  const b: T[] = [];
  for (const item of items) {
    if (predicate(item)) {
      a.push(item);
    } else {
      b.push(item);
    }
  }

  return [a, b];
}

/**
 * Flattens an array of arrays into a single-dimensional array.
 */
export function flatten<T>(items: ReadonlyArray<ReadonlyArray<T>>): T[] {
  let out: T[] = [];
  for (const list of items) {
    out = out.concat(list);
  }

  return out;
}

/**
 * Picks the subset of keys from the object.
 */
export function pick<T>(obj: T, keys: ReadonlyArray<keyof T>): Partial<T> {
  const partial: Partial<T> = {};
  for (const key of keys) {
    partial[key] = obj[key];
  }

  return partial;
}
