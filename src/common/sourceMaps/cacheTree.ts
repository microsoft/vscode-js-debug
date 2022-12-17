/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

const touched = Symbol('touched');

/**
 * Readily serializable tree of cache entries.
 */
export type CacheTree<T> = { data?: T; children: Record<string, CacheTree<T>>; [touched]?: true };

export namespace CacheTree {
  /** Creates a root for a new cache tree. */
  export function root<T>(): CacheTree<T> {
    return { children: {}, [touched]: true };
  }
  /**
   * Gets the cache entry at the given directory path. Assumes this is the
   * root cache entry, the directory has no relative parts, and is
   * separated with forward slashes.
   */
  export function getPath<T>(node: CacheTree<T>, directory: string) {
    return _getDir(node, splitDir(directory), 0);
  }

  /**
   * Gets a child directory of the given name, creating it if it doesn't exist.
   */
  export function getOrMakeChild<T>(node: CacheTree<T>, name: string): CacheTree<T> {
    const child = (node.children[name] ??= { children: {} });
    child[touched] = true;
    return child;
  }

  /**
   * Removes items in the tree that were not touched since being created.
   */
  export function prune<T>(node: CacheTree<T>) {
    for (const [name, child] of Object.entries(node.children)) {
      if (!child[touched]) {
        delete node.children[name];
      } else {
        prune(child);
      }
    }
  }

  function splitDir(dir: string) {
    const parts = dir.split(/\/|\\/);
    if (parts[0] === '') {
      parts.unshift();
    }

    return parts;
  }

  function _getDir<T>(node: CacheTree<T>, parts: string[], i: number): CacheTree<T> {
    const child = getOrMakeChild(node, parts[i]);
    if (i === parts.length - 1) {
      return child;
    }

    return _getDir(node, parts, i + 1);
  }
}
