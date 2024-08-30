/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { Dirent, promises as fs, Stats } from 'fs';
import micromatch from 'micromatch';
import { isAbsolute, relative, sep } from 'path';
import toAbsGlob from 'to-absolute-glob';
import { EventEmitter } from '../events';
import { memoize } from '../objUtils';
import { forceForwardSlashes } from '../pathUtils';
import { CacheTree } from './cacheTree';

interface IParsedMinimatch {
  tokens: MinimatchToken[];
}

type MinimatchToken =
  | { type: 'bos'; value: string; output: string }
  | { type: 'star'; value: string; output: string }
  | { type: 'text'; value: 'string'; output: string }
  | { type: 'slash'; value: '/'; output: string }
  | { type: 'globstar'; value: string; output: string };

type PatternElem = string | RegExp;

interface ITokensContext {
  elements: PatternElem[];
  seen: Set<string>;
}

export type FileProcessorFn<T> = (
  path: string,
  metadata: { siblings: readonly string[]; mtime: number },
) => Promise<T>;

export interface ITurboGlobStreamOptions<E> {
  /** Glob patterns */
  pattern: string;
  /** Glob ignores */
  ignore: readonly string[];
  /** Glob cwd */
  cwd: string;
  /** Filters for child paths who should be processed and emitted. */
  filter?: (path: string, previousData?: E) => boolean;
  /** Cache state, will be updated. */
  cache: CacheTree<IGlobCached<E>>;
  /** File to transform a path into extracted data emitted on onFile */
  fileProcessor: FileProcessorFn<E>;
}

const forwardSlashRe = /\//g;

/**
 * A smart, cachable glob-stream-like implementation. Caches tree info in its
 * `CacheTree` and takes an extractor to pull and cache data from files.
 */
export class TurboGlobStream<E> {
  /** Promise that resolves once globbing is done */
  public readonly done: Promise<void>;

  private readonly stat = memoize((path: string) => fs.lstat(path));
  private readonly readdir = memoize((path: string) => fs.readdir(path, { withFileTypes: true }));
  private readonly alreadyProcessedFiles = new Set<CacheTree<IGlobCached<E>>>();

  private readonly filter?: (path: string, previousData?: E) => boolean;
  private readonly ignore: ((path: string) => boolean)[];
  private readonly processor: FileProcessorFn<E>;
  private readonly fileEmitter = new EventEmitter<E>();
  public readonly onFile = this.fileEmitter.event;
  private readonly errorEmitter = new EventEmitter<{ path: string; error: Error }>();
  public readonly onError = this.errorEmitter.event;

  constructor(opts: ITurboGlobStreamOptions<E>) {
    this.processor = opts.fileProcessor;
    this.filter = opts.filter;

    // ignore will get matched against the full file path, so ensure it's absolute
    this.ignore = opts.ignore.map(i =>
      micromatch.matcher(toAbsGlob(forceForwardSlashes(i), { cwd: opts.cwd }))
    );

    // pattern is parsed and then built on the cwd, so ensure it's relative
    const pattern = isAbsolute(opts.pattern) ? relative(opts.cwd, opts.pattern) : opts.pattern;

    const match = micromatch.parse(forceForwardSlashes(pattern), {
      ignore: opts.ignore,
      cwd: opts.cwd,
      // Expand braces into multiple regexes, since dealing with them is tricky
      // This isn't on DT, so the cast is necesssary
      expand: true,
    } as micromatch.Options) as IParsedMinimatch[];

    this.done = Promise.all(
      match.map(m => {
        const tokens: PatternElem[] = [];
        // start at 1, since 0 is 'bos'
        for (let i = 1; i < m.tokens.length;) {
          let nextSlash = i + 1;
          while (nextSlash < m.tokens.length && m.tokens[nextSlash].type !== 'slash') {
            nextSlash++;
          }

          const first = m.tokens[i];
          if (first.type === 'globstar') {
            tokens.push('**');
          } else if (nextSlash === i + 1 && first.type === 'text') {
            tokens.push(first.value);
          } else {
            tokens.push(
              new RegExp(
                '^'
                  + m.tokens
                    .slice(i, nextSlash)
                    .map(t => t.output || t.value)
                    .join('')
                  + '$',
              ),
            );
          }

          i = nextSlash + 1;
        }

        // base case of starting with a **, normally handled by `getDirectoryReadDescends`
        const depths = tokens[0] === '**' ? [0, 1] : [0];
        const cacheEntry = CacheTree.getPath(opts.cache, opts.cwd);
        const ctx = { elements: tokens, seen: new Set<string>() };
        return Promise.all(depths.map(d => this.readSomething(ctx, d, opts.cwd, [], cacheEntry)));
      }),
    ).then(() => undefined);
  }

  /**
   * Entrypoint for reading a new entry. Does a stat and, based on mtime,
   * either pulls cached info or handles the file/directory.
   */
  private async readSomething(
    ctx: ITokensContext,
    ti: number,
    path: string,
    siblings: readonly string[],
    cache: CacheTree<IGlobCached<E>>,
  ) {
    // Skip already processed files, since we might see them twice during glob stars.
    if (this.alreadyProcessedFiles.has(cache)) {
      return;
    }

    // Skip generic paths (we don't know if it's a file or not at this point)
    // if we already visited that with the same token index state.
    const seenKey = `${ti}:${path}`;
    if (ctx.seen.has(seenKey)) {
      return;
    }
    ctx.seen.add(seenKey);

    let stat: Stats;
    try {
      stat = await this.stat(path);
    } catch (error) {
      this.errorEmitter.fire({ path, error });
      return;
    }

    // ...and double check since we might have gotten the file while stat() happened
    if (this.alreadyProcessedFiles.has(cache)) {
      return;
    }

    const cd = cache.data;
    if (cd && stat.mtimeMs === cd.mtime) {
      // if the mtime of a directory is the same, there are have been no direct
      // children added or removed.
      if (cd.type === CachedType.Directory) {
        const todo: unknown[] = [];
        const entries = Object.entries(cache.children);
        const siblings = entries
          .filter(([, e]) => e.data?.type !== CachedType.Directory)
          .map(([n]) => n);

        for (const [name, child] of Object.entries(cache.children)) {
          // for cached objects with a type, recurse normally. For ones without,
          // try to stat them first (may have been interrupted before they were finished)
          todo.push(
            child.data !== undefined
              ? this.handleDirectoryEntry(
                ctx,
                ti,
                path,
                { name, type: child.data.type },
                siblings,
                cache,
              )
              : this.stat(path).then(
                stat =>
                  this.handleDirectoryEntry(
                    ctx,
                    ti,
                    path,
                    { name, type: stat.isFile() ? CachedType.File : CachedType.Directory },
                    siblings,
                    cache,
                  ),
                () => undefined,
              ),
          );
        }
        await Promise.all(todo);
      } else if (cd.type === CachedType.File) {
        this.alreadyProcessedFiles.add(cache);
        this.fileEmitter.fire(cd.extracted);
      }
      return;
    }

    // handleDir/handleFile will update cache.data once they have enough info
    if (stat.isDirectory()) {
      await this.handleDir(ctx, ti, stat.mtimeMs, path, cache);
    } else {
      this.alreadyProcessedFiles.add(cache);
      await this.handleFile(stat.mtimeMs, path, siblings, cache);
    }
  }

  private applyFilterToFile(name: string, path: string, parentCache: CacheTree<IGlobCached<E>>) {
    const child = parentCache.children[name];
    if (this.alreadyProcessedFiles.has(child)) {
      return false;
    }

    if (!this.filter) {
      return true;
    }

    const data = child.data?.type === CachedType.File ? child.data.extracted : undefined;
    CacheTree.touch(child);

    return this.filter(path, data);
  }

  /**
   * Called to recurse on a directory entry.
   * @param path Path of the directory containing `dirent`
   * @param cache Cache tree node of the directory containing `dirent`
   */
  private handleDirectoryEntry(
    ctx: ITokensContext,
    ti: number,
    path: string,
    dirent: { name: string; type: CachedType },
    siblings: readonly string[],
    cache: CacheTree<IGlobCached<E>>,
  ): unknown {
    const nextPath = path + '/' + dirent.name;
    const descends = this.getDirectoryReadDescends(ctx, ti, path, dirent);
    if (descends === undefined) {
      return;
    }

    // note: intentionally making the child before the filter check, so it
    // exists in the tree even if this current glob filters it out
    const nextChild = CacheTree.getOrMakeChild(cache, dirent.name);
    if (dirent.type === CachedType.File && !this.applyFilterToFile(dirent.name, nextPath, cache)) {
      return;
    }

    if (typeof descends === 'number') {
      return this.readSomething(ctx, ti + descends, nextPath, siblings, nextChild);
    } else {
      return Promise.all(
        descends.map(d => this.readSomething(ctx, ti + d, nextPath, siblings, nextChild)),
      );
    }
  }

  /**
   * Called for a directory entry. If the item should be processed, returns
   * how far to advance `ti` in the subsequent `readSomething`. If it should
   * not be processed, returns undefined.
   * @param path Path of the directory containing `dirent`
   */
  private getDirectoryReadDescends(
    ctx: ITokensContext,
    ti: number,
    path: string,
    dirent: { name: string; type: CachedType },
  ): undefined | number | number[] {
    const nextPath = path + '/' + dirent.name;
    if (this.ignore.some(i => i(nextPath))) {
      return;
    }

    const isTerminal = ti === ctx.elements.length - 1;
    const token = ctx.elements[ti];

    if (token === '**') {
      // files never match ** if there's more to read
      if (dirent.type === CachedType.File) {
        return isTerminal ? 0 : this.getDirectoryReadDescends(ctx, ti + 1, path, dirent);
      }

      if (isTerminal) {
        return 0;
      }

      // A ** is a classic regex branch. Fortunately due to caching we don't
      // do any extra filesystem operations, but we do need to recurse twice...
      return [0, 1];
    }

    if ((token instanceof RegExp && token.test(dirent.name)) || token === dirent.name) {
      // directories cannot be the terminal match, and files must be
      if (dirent.type === CachedType.Directory ? !isTerminal : isTerminal) {
        return 1;
      }
    }
  }

  private async handleFile(
    mtime: number,
    path: string,
    siblings: readonly string[],
    cache: CacheTree<IGlobCached<E>>,
  ) {
    const platformPath = sep === '/' ? path : path.replace(forwardSlashRe, sep);
    let extracted: E;
    try {
      extracted = await this.processor(platformPath, { siblings, mtime });
    } catch (error) {
      this.errorEmitter.fire({ path: platformPath, error });
      return;
    }

    cache.data = { type: CachedType.File, mtime, extracted };
    this.fileEmitter.fire(extracted);
  }

  private async handleDir(
    ctx: ITokensContext,
    ti: number,
    mtime: number,
    path: string,
    cache: CacheTree<IGlobCached<E>>,
  ) {
    let files: Dirent[];
    try {
      files = await this.readdir(path);
    } catch (error) {
      this.errorEmitter.fire({ path, error });
      return;
    }

    const todo: unknown[] = [];
    const siblings = files.filter(f => f.isFile()).map(f => f.name);
    for (const file of files) {
      if (file.name.startsWith('.')) {
        continue;
      }

      let type: CachedType;
      if (file.isDirectory()) {
        type = CachedType.Directory;
      } else if (file.isFile()) {
        type = CachedType.File;
      } else {
        continue;
      }

      todo.push(
        this.handleDirectoryEntry(ctx, ti, path, { name: file.name, type }, siblings, cache),
      );
    }

    await Promise.all(todo);
    cache.data = { type: CachedType.Directory, mtime };
  }
}

export type IGlobCached<TFileData> =
  | {
    type: CachedType.Directory;
    mtime: number;
  }
  | {
    type: CachedType.File;
    mtime: number;
    extracted: TFileData;
  };

const enum CachedType {
  Directory,
  File,
}
