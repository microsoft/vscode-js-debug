/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { promises as fs, Stats } from 'fs';
import micromatch from 'micromatch';
import { EventEmitter } from '../events';
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

/**
 * A smart, cachable glob-stream-like implementation. Caches tree info in its
 * `CacheTree` and takes an extractor to pull and cache data from files.
 */
export class TurboGlobStream<E> {
  /** Promise that resolves once globbing is done */
  public readonly done: Promise<void>;

  private readonly alreadyProcessedFiles = new Set<CacheTree<IGlobCached<E>>>();
  private readonly alreadyReadDirs = new Map<string, Promise<string[]>>();
  private readonly alreadyStatedPaths = new Map<string, Promise<Stat>>();

  private readonly ignore: ((path: string) => boolean)[];
  private readonly processor: (path: string) => Promise<E>;
  private readonly fileEmitter = new EventEmitter<E>();
  public readonly onFile = this.fileEmitter.event;
  private readonly errorEmitter = new EventEmitter<{ path: string; error: Error }>();
  public readonly onError = this.errorEmitter.event;

  constructor(opts: {
    pattern: string;
    ignore: readonly string[];
    cwd: string;
    cache: CacheTree<IGlobCached<E>>;
    fileProcessor: (path: string) => Promise<E>;
  }) {
    const scanned = micromatch.scan(opts.pattern);
    // narrow the cwd to `${cwd}/foo/bar` if the pattern is like `foo/bar/**`
    const cwd = scanned.base ? opts.cwd + '/' + scanned.base : opts.cwd;
    const globToParse = opts.pattern.slice(cwd.length + 1) || '**/*';
    this.processor = opts.fileProcessor;
    this.ignore = opts.ignore.map(i => micromatch.matcher(i, { cwd: opts.cwd, matchBase: true }));

    const match = micromatch.parse(globToParse, {
      ignore: opts.ignore,
      cwd,
      matchBase: true,
      // Expand braces into multiple regexes, since dealing with them is tricky
      // This isn't on DT, so the cast is necesssary
      expand: true,
    } as micromatch.Options) as IParsedMinimatch[];

    this.done = Promise.all(
      match.map(async m => {
        const tokens: PatternElem[] = [];
        // start at 1, since 0 is 'bos'
        for (let i = 1; i < m.tokens.length; ) {
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
                '^' +
                  m.tokens
                    .slice(0, nextSlash)
                    .map(t => t.output || t.value)
                    .join('') +
                  '$',
              ),
            );
          }

          i = nextSlash + 1;
        }

        return this.readSomething(tokens, 0, cwd, CacheTree.getPath(opts.cache, cwd));
      }),
    ).then(() => undefined);
  }

  /**
   * Entrypoint for reading a new entry. Does a stat and, based on mtime,
   * either pulls cached info or handles the file/directory.
   */
  private async readSomething(
    tokens: readonly PatternElem[],
    ti: number,
    path: string,
    cache: CacheTree<IGlobCached<E>>,
  ) {
    // Skip already processed files, since we might see them twice during glob stars.
    // Note we *don't* skip directories, since their tokens/ti state will be different
    // and could result in later recursion.
    if (this.alreadyProcessedFiles.has(cache)) {
      return;
    }

    let stat: Stats;
    try {
      const existing = this.alreadyStatedPaths.get(path);
      if (existing) {
        stat = await existing;
      } else {
        const promise = fs.stat(path);
        this.alreadyStatedPaths.set(path, promise);
        stat = await promise;
      }
    } catch (error) {
      this.errorEmitter.fire({ path, error });
      return;
    }

    // ...and double check since we might have gotten the file while stat() happened
    if (this.alreadyProcessedFiles.has(cache)) {
      return;
    }

    const cd = cache.data;
    if (cd && stat.mtimeMs === cd?.mtime) {
      // if the mtime of a directory is the same, there are have been no direct
      // children added or removed.
      if (cd.type === CachedType.Directory) {
        const todo: Promise<void>[] = [];
        for (const [name, child] of Object.entries(cache.children)) {
          const cpath = path + '/' + name;
          todo.push(this.readSomething(tokens, ti, cpath, child));
        }
        await Promise.all(todo);
      } else if (cd.type === CachedType.File) {
        this.fileEmitter.fire(cd.extracted);
      }
      return;
    }

    // readdir/readfile will update cache.data once they have enough info
    if (stat.isDirectory()) {
      await this.readDir(tokens, ti, stat.mtimeMs, path, cache);
    } else {
      this.alreadyProcessedFiles.add(cache);
      await this.handleFile(stat.mtimeMs, path, cache);
    }
  }

  private handleDirectoryEntry(
    tokens: readonly PatternElem[],
    ti: number,
    path: string,
    name: string,
    cache: CacheTree<IGlobCached<E>>,
  ) {
    const nextPath = path + '/' + name;
    if (this.ignore.some(i => i(nextPath))) {
      return;
    }

    const nextChild = CacheTree.getOrMakeChild(cache, name);

    const token = tokens[ti];
    if (token === '**') {
      // A ** is a classic regex branch. Fortunately due to caching we don't
      // do any extra filesystem operations, but we do need to recurse twice...
      return Promise.all([
        this.readSomething(tokens, ti + 1, nextPath, nextChild),
        this.readSomething(tokens, ti, nextPath, nextChild),
      ]);
    }

    if ((token instanceof RegExp && token.test(name)) || token === name) {
      return this.readSomething(tokens, ti + 1, nextPath, nextChild);
    }
  }

  private async handleFile(mtime: number, path: string, cache: CacheTree<IGlobCached<E>>) {
    let extracted: E;
    try {
      extracted = await this.processor(path);
    } catch (error) {
      this.errorEmitter.fire({ path, error });
      return;
    }

    cache.data = { type: CachedType.File, mtime, extracted };
    this.fileEmitter.fire(extracted);
  }

  private async readDir(
    tokens: readonly PatternElem[],
    ti: number,
    mtime: number,
    path: string,
    cache: CacheTree<IGlobCached<E>>,
  ) {
    let files: string[];
    try {
      const existing = this.alreadyReadDirs.get(path);
      if (existing) {
        files = await existing;
      } else {
        const promise = fs.readdir(path);
        this.alreadyReadDirs.set(path, promise);
        files = await promise;
      }
    } catch (error) {
      this.errorEmitter.fire({ path, error });
      return;
    }

    const todo: (Promise<unknown> | undefined)[] = [];
    for (const file of files) {
      if (file.startsWith('.')) {
        continue;
      }

      todo.push(this.handleDirectoryEntry(tokens, ti, path, file, cache));
    }

    cache.data = { type: CachedType.Directory, mtime };
    await Promise.all(todo);
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
