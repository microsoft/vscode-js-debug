/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { Position as ESTreePosition } from 'estree';
import { Worker } from 'worker_threads';
import { Base01Position, IPosition, Range } from '../positions';
import { extractScopeRangesWithFactory as extractScopeFlatTree } from './renameWorker';

export type FlatTree = { start: ESTreePosition; end: ESTreePosition; depth: number }[];

/**
 * A tree node extracted via `extractScopeRanges`.
 */
export class ScopeNode<T> {
  /** Children of the scope range, if any */
  public children?: ScopeNode<T>[];
  /** Custom associated data */
  public data?: T;

  /** Hydrates a serialized tree */
  public static hydrate<T>(
    flat: FlatTree,
    depthFirstHydration: (node: ScopeNode<T>) => T | undefined,
  ): ScopeNode<T> {
    const root = new ScopeNode<T>(
      new Range(
        new Base01Position(flat[0].start.line, flat[0].start.column),
        new Base01Position(flat[0].end.line, flat[0].end.column),
      ),
    );

    const stack = [root];
    let stackLen = 1;

    for (let i = 1; i < flat.length; i++) {
      const node = flat[i];
      while (node.depth < stackLen) {
        stackLen--;
        stack[stackLen].data = depthFirstHydration(stack[stackLen]);
      }

      const hydrated = new ScopeNode<T>(
        new Range(
          new Base01Position(node.start.line, node.start.column),
          new Base01Position(node.end.line, node.end.column),
        ),
      );

      const parent = stack[stackLen - 1];
      parent.children ??= [];
      parent.children.push(hydrated);
      stack[stackLen++] = hydrated;
    }

    for (let i = stackLen - 1; i >= 0; i--) {
      stack[i].data = depthFirstHydration(stack[i]);
    }

    return root;
  }

  constructor(public readonly range: Range) {}

  /** Gets the scope range containing the desired position */
  public search(pos: IPosition): ScopeNode<T> | undefined {
    if (!this.range.contains(pos)) {
      return undefined;
    }

    if (!this.children) {
      return this;
    }

    for (const child of this.children) {
      const found = child.search(pos);
      if (found) {
        return found;
      }
    }

    return this;
  }

  /** Finds the deepest node matching the predicate and containing the position. */
  public findDeepest<R>(
    position: IPosition,
    predicate: (node: ScopeNode<T>) => R | undefined,
  ): R | undefined {
    if (!this.range.contains(position)) {
      return undefined;
    }

    if (this.children) {
      for (const child of this.children) {
        const found = child.findDeepest(position, predicate);
        if (found !== undefined) {
          return found;
        }
      }
    }

    return predicate(this);
  }

  /**
   * Recursively removes nodes from the tree who don't pass the filter. If a
   * node does not pass the filter but its children do, the children will be
   * rehomed to a parent node that passes the filter. Never removes the root.
   */
  public filterHoist(predicate: (node: ScopeNode<T>) => boolean): void {
    if (!this.children) {
      return;
    }

    for (let i = 0; i < this.children.length; i++) {
      const child = this.children[i];
      child.filterHoist(predicate);

      if (!predicate(child)) {
        const grandChildren = child.children || [];
        this.children.splice(i, 1, ...grandChildren);
        i--;
      }
    }
  }

  /** Runs the function on each node in the tree, breadth-first. */
  public forEach(fn: (node: ScopeNode<T>) => void) {
    fn(this);
    this.children?.forEach(c => c.forEach(fn));
  }

  /** Runs the function on each node in the tree, depth-first */
  public forEachDepthFirst(fn: (node: ScopeNode<T>) => void) {
    this.children?.forEach(c => c.forEach(fn));
    fn(this);
  }

  public toJSON() {
    return {
      range: this.range,
      children: this.children,
    };
  }
}

const WORKER_SIZE_THRESHOLD = 1024 * 512;

/**
 * Gets ranges of scopes in the source code. It returns ranges where variables
 * declared in those ranges apply to all child scopes. For example,
 * `function(foo) { bar(); }` emits `(foo) { bar(); }` as a range.
 *
 * `depthFirstHydration` is called on each node in a depth-first order to
 * allow creating data as serialization/deserialization happens.
 */
export function extractScopeRanges<T>(
  source: string,
  depthFirstHydration: (node: ScopeNode<T>) => T | undefined,
) {
  if (source.length < WORKER_SIZE_THRESHOLD) {
    return ScopeNode.hydrate<T>(extractScopeFlatTree(source), depthFirstHydration);
  }

  return new Promise<ScopeNode<T>>((resolve, reject) => {
    const worker = new Worker(`${__dirname}/renameWorker.js`, {
      workerData: source,
    });

    worker.on('message', msg => resolve(ScopeNode.hydrate<T>(msg, depthFirstHydration)));
    worker.on('error', reject);
    worker.on('exit', () => reject('rename worker exited'));
  });
}
