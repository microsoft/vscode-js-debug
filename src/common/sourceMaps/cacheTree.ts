/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

const touched = Symbol('touched');

/**
 * Readily serializable tree of cache entries.
 */
export type CacheTree<T> = {
  data?: T;
  children: Record<string, CacheTree<T>>;
  [touched]?: number;
};

export namespace CacheTree {
  /** Creates a root for a new cache tree. */
  export function root<T>(): CacheTree<T> {
    return { children: {}, [touched]: 1 };
  }
  /**
   * Gets the cache entry at the given directory path. Assumes this is the
   * root cache entry, the directory has no relative parts, and is
   * separated with forward slashes.
   */
  export function getPath<T>(node: CacheTree<T>, directory: string) {
    node[touched] = 1;
    return _getDir(node, splitDir(directory), 0);
  }

  /**
   * Marks the node as having been touched, so prune() doesn't remove it.
   */
  export function touch<T>(node: CacheTree<T>) {
    node[touched] = 1;
  }

  /**
   * Marks the subtree as having been touched, so prune() doesn't remove it.
   */
  export function touchAll<T>(node: CacheTree<T>) {
    node[touched] = 2;
  }

  /**
   * Gets a child directory of the given name, creating it if it doesn't exist.
   */
  export function getOrMakeChild<T>(node: CacheTree<T>, name: string): CacheTree<T> {
    const child = (node.children[name] ??= { children: {} });
    child[touched] = 1;
    return child;
  }

  /**
   * Removes items in the tree that were not touched since being created.
   */
  export function prune<T>(node: CacheTree<T>): CacheTree<T> | undefined {
    if (!node[touched]) {
      return undefined;
    }

    for (const [name, child] of Object.entries(node.children)) {
      switch (child[touched]) {
        case 1:
          prune(child);
          break;
        case 2:
          break;
        default:
          delete node.children[name];
      }
    }

    return node;
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

    return _getDir(child, parts, i + 1);
  }
}
