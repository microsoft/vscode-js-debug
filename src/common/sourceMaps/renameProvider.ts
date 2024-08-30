/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { inject, injectable } from 'inversify';
import { isSourceWithSourceMap, Source, SourceFromMap } from '../../adapter/source';
import { StackFrame } from '../../adapter/stackTrace';
import { AnyLaunchConfiguration } from '../../configuration';
import { iteratorFirst } from '../arrayUtils';
import { ILogger, LogTag } from '../logging';
import { IPosition, Range } from '../positions';
import { extractScopeRenames } from './renameScopeAndSourceMap';
import { ScopeNode } from './renameScopeTree';
import { SourceMap } from './sourceMap';
import { ISourceMapFactory } from './sourceMapFactory';

export interface IRename {
  original: string;
  compiled: string;
}

export interface IRenameProvider {
  /**
   * Provides renames at the given stackframe.
   */
  provideOnStackframe(frame: StackFrame): RenameMapping | Promise<RenameMapping>;

  /**
   * Provides renames for the given Source.
   */
  provideForSource(source: Source | undefined): RenameMapping | Promise<RenameMapping>;
}

export const IRenameProvider = Symbol('IRenameProvider');

@injectable()
export class RenameProvider implements IRenameProvider {
  private renames = new Map</* source uri */ string, Promise<RenameMapping>>();

  constructor(
    @inject(ILogger) private readonly logger: ILogger,
    @inject(ISourceMapFactory) private readonly sourceMapFactory: ISourceMapFactory,
    @inject(AnyLaunchConfiguration) private readonly launchConfig: AnyLaunchConfiguration,
  ) {}

  /**
   * @inheritdoc
   */
  public provideOnStackframe(frame: StackFrame) {
    if (!this.launchConfig.sourceMapRenames) {
      return RenameMapping.None;
    }

    const location = frame.uiLocation();
    if (location === undefined) {
      return RenameMapping.None;
    } else if ('then' in location) {
      return location.then(s => this.provideForSource(s?.source));
    } else {
      return this.provideForSource(location?.source);
    }
  }

  /**
   * @inheritdoc
   */
  public provideForSource(source: Source | undefined) {
    if (!this.launchConfig.sourceMapRenames) {
      return RenameMapping.None;
    }

    if (!(source instanceof SourceFromMap)) {
      return RenameMapping.None;
    }

    const original = iteratorFirst(source.compiledToSourceUrl.keys());
    if (!original) {
      throw new Error('unreachable');
    }

    if (!isSourceWithSourceMap(original)) {
      return RenameMapping.None;
    }

    const cached = this.renames.get(original.url);
    if (cached) {
      return cached;
    }

    const promise = this.sourceMapFactory
      .load(original.sourceMap.metadata)
      .then(async sm => {
        if (!sm?.hasNames) {
          return RenameMapping.None;
        }

        const content = await original.content();
        return content ? await this.createFromSourceMap(sm, content) : RenameMapping.None;
      })
      .catch(() => RenameMapping.None);

    this.renames.set(original.url, promise);
    return promise;
  }

  private async createFromSourceMap(sourceMap: SourceMap, content: string) {
    const start = Date.now();

    let scopeTree: ScopeNode<IRename[]>;
    try {
      scopeTree = await extractScopeRenames(content, sourceMap);
    } catch (e) {
      this.logger.info(LogTag.Runtime, `Error parsing content for source tree: ${e}}`, {
        url: sourceMap.metadata.compiledPath,
      });
      return RenameMapping.None;
    }

    const end = Date.now();
    this.logger.info(LogTag.Runtime, `renames calculated in ${end - start}ms`, {
      url: sourceMap.metadata.compiledPath,
    });

    return new RenameMapping(scopeTree);
  }
}

/**
 * Accessor for mapping of compiled and original source names. This works by
 * getting the rename closest to a compiled position. It would be more
 * correct to parse the AST and use scopes, but doing so is relatively slow.
 * This is probably good enough.
 */
export class RenameMapping {
  public static None = new RenameMapping(new ScopeNode(Range.ZERO));

  constructor(private readonly renames: ScopeNode<IRename[]>) {}

  /**
   * Gets the original identifier name from a compiled name, with the
   * interpreter paused at the given position.
   */
  public getOriginalName(compiledName: string, compiledPosition: IPosition) {
    return this.getClosestRename(compiledPosition, r => r.compiled === compiledName)?.original;
  }

  /**
   * Gets the compiled identifier name from an original name.
   */
  public getCompiledName(originalName: string, compiledPosition: IPosition) {
    return this.getClosestRename(compiledPosition, r => r.original === originalName)?.compiled;
  }

  private getClosestRename(compiledPosition: IPosition, filter: (rename: IRename) => boolean) {
    return this.renames.findDeepest(compiledPosition, n => n.data?.find(filter));
  }
}
