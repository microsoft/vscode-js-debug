/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

export function asArray<T>(thing: T | readonly T[]): readonly T[] {
  return thing instanceof Array ? thing : [thing];
}

/**
 * Runs a binary search on the array. Returns the index of the key if it were
 * to be inserted into the array to retain order.
 */
export function binarySearch<T>(
  array: ArrayLike<T>,
  key: T,
  comparator: (a: T, b: T) => number,
): number {
  let low = 0;
  let high = array.length - 1;

  while (low <= high) {
    const mid = ((low + high) / 2) | 0;
    const comp = comparator(array[mid], key);
    if (comp < 0) {
      low = mid + 1;
    } else if (comp > 0) {
      high = mid - 1;
    } else {
      return mid;
    }
  }

  return low;
}

/**
 * Groups an array using an accessor function.
 */
export function groupBy<T, K>(array: T[], accessor: (item: T) => K): Map<K, T[]> {
  const groups: Map<K, T[]> = new Map();

  for (const item of array) {
    const key = accessor(item);
    const group = groups.get(key);
    if (group) {
      group.push(item);
    } else {
      groups.set(key, [item]);
    }
  }

  return groups;
}

export function iteratorFirst<T>(it: IterableIterator<T>): T | undefined {
  return it.next().value;
}
