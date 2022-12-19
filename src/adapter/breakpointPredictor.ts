/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { inject, injectable } from 'inversify';
import * as path from 'path';
import { Event } from 'vscode';
import { IDisposable } from '../common/disposable';
import { EventEmitter } from '../common/events';
import { OutFiles } from '../common/fileGlobList';
import { ILogger, LogTag } from '../common/logging';
import { CorrelatedCache } from '../common/sourceMaps/mtimeCorrelatedCache';
import { ISourceMapMetadata, SourceMap } from '../common/sourceMaps/sourceMap';
import { CachingSourceMapFactory, ISourceMapFactory } from '../common/sourceMaps/sourceMapFactory';
import { ISearchStrategy } from '../common/sourceMaps/sourceMapRepository';
import { ISourcePathResolver } from '../common/sourcePathResolver';
import { getOptimalCompiledPosition } from '../common/sourceUtils';
import * as urlUtils from '../common/urlUtils';
import { AnyLaunchConfiguration } from '../configuration';
import Dap from '../dap/api';
import { logPerf } from '../telemetry/performance';

export interface IWorkspaceLocation {
  absolutePath: string;
  lineNumber: number; // 1-based
  columnNumber: number; // 1-based
}

type DiscoveredMetadata = ISourceMapMetadata & { sourceUrl: string; resolvedPath: string };
type MetadataMap = Map<string, Set<DiscoveredMetadata>>;

const longPredictionWarning = 10 * 1000;

export const IBreakpointsPredictor = Symbol('IBreakpointsPredictor');

/**
 * Determines ahead of time where to set breakpoints in the target files
 * by looking at source maps on disk.
 */
export interface IBreakpointsPredictor {
  /**
   * Event emitted if a performance issue is detected parsing outFiles.
   */
  onLongParse: Event<void>;

  /**
   * Gets prediction data for the given source file path, if it exists.
   */
  getPredictionForSource(sourceFile: string): Promise<ReadonlySet<DiscoveredMetadata> | undefined>;

  /**
   * Returns a promise that resolves once maps in the root are predicted.
   */
  prepareToPredict(): Promise<void>;

  /**
   * Returns a promise that resolves when breakpoints for the given location
   * are predicted.
   */
  predictBreakpoints(params: Dap.SetBreakpointsParams): Promise<void>;

  /**
   * Returns predicted breakpoint locations for the provided source.
   */
  predictedResolvedLocations(location: IWorkspaceLocation): IWorkspaceLocation[];
}

/**
 * Wrapper around a breakpoint predictor which allows its implementation to
 * be replaced. This is used to implement a heuristic used when dealing with
 * hot-reloading tools like Nodemon or Nest.js development: when a child
 * session terminates, the next child of the parent session will
 * rerun prediction.
 */
export class BreakpointPredictorDelegate implements IBreakpointsPredictor, IDisposable {
  private childImplementation: IBreakpointsPredictor;

  /**
   * @inheritdoc
   */
  public get onLongParse() {
    return this.implementation.onLongParse;
  }

  constructor(
    private readonly sourceMapFactory: ISourceMapFactory,
    private readonly factory: () => IBreakpointsPredictor,
    private implementation = factory(),
    private readonly parent?: BreakpointPredictorDelegate,
  ) {
    if (implementation instanceof BreakpointPredictorDelegate) {
      this.implementation = implementation.implementation;
    }

    this.childImplementation = this.implementation;
  }

  /**
   * Invalidates the internal predictor, such that the next child will get
   * a new instance of the breakpoint predictor. This is used to deal with
   * hot-reloading scripts like Nodemon.
   */
  private invalidateNextChild() {
    if (this.sourceMapFactory instanceof CachingSourceMapFactory) {
      this.sourceMapFactory.invalidateCache();
    }

    this.childImplementation = this.factory();
  }

  /**
   * Gets a breakpoint predictor for the child.
   */
  getChild() {
    return new BreakpointPredictorDelegate(
      this.sourceMapFactory,
      this.factory,
      this.childImplementation,
      this,
    );
  }

  /**
   * @inheritdoc
   */
  getPredictionForSource(sourceFile: string) {
    return this.implementation.getPredictionForSource(sourceFile);
  }

  /**
   * @inheritdoc
   */
  prepareToPredict() {
    return this.implementation.prepareToPredict();
  }

  /**
   * @inheritdoc
   */
  predictBreakpoints(params: Dap.SetBreakpointsParams) {
    return this.implementation.predictBreakpoints(params);
  }

  /**
   * @inheritdoc
   */
  predictedResolvedLocations(location: IWorkspaceLocation) {
    return this.implementation.predictedResolvedLocations(location);
  }

  /**
   * @inheritdoc
   */
  dispose() {
    this.parent?.invalidateNextChild();
  }
}

@injectable()
export class BreakpointsPredictor implements IBreakpointsPredictor {
  private readonly predictedLocations = new Map<string, IWorkspaceLocation[]>();
  private readonly longParseEmitter = new EventEmitter<void>();
  private sourcePathToCompiled?: Promise<MetadataMap>;
  private cache?: CorrelatedCache<number, { sourceUrl: string; resolvedPath: string }[]>;

  /**
   * Event that fires if it takes a long time to predict sourcemaps.
   */
  public readonly onLongParse = this.longParseEmitter.event;

  constructor(
    @inject(AnyLaunchConfiguration) launchConfig: AnyLaunchConfiguration,
    @inject(OutFiles) private readonly outFiles: OutFiles,
    @inject(ISearchStrategy) private readonly repo: ISearchStrategy,
    @inject(ILogger) private readonly logger: ILogger,
    @inject(ISourceMapFactory) private readonly sourceMapFactory: ISourceMapFactory,
    @inject(ISourcePathResolver)
    private readonly sourcePathResolver: ISourcePathResolver | undefined,
  ) {
    if (launchConfig.__workspaceCachePath) {
      this.cache = new CorrelatedCache(
        path.join(launchConfig.__workspaceCachePath, 'bp-predict.json'),
      );
    }
  }

  private async createInitialMapping(): Promise<MetadataMap> {
    return logPerf(this.logger, `BreakpointsPredictor.createInitialMapping`, () =>
      this.createInitialMappingInner(),
    );
  }

  private async createInitialMappingInner(): Promise<MetadataMap> {
    if (this.outFiles.empty) {
      return new Map();
    }

    const sourcePathToCompiled: MetadataMap = urlUtils.caseNormalizedMap();
    const addDiscovery = (discovery: DiscoveredMetadata) => {
      let set = sourcePathToCompiled.get(discovery.resolvedPath);
      if (!set) {
        set = new Set();
        sourcePathToCompiled.set(discovery.resolvedPath, set);
      }

      set.add(discovery);
    };

    const warnLongRuntime = setTimeout(() => {
      this.longParseEmitter.fire();
      this.logger.warn(LogTag.RuntimeSourceMap, 'Long breakpoint predictor runtime', {
        type: this.repo.constructor.name,
        longPredictionWarning,
        patterns: [...this.outFiles.explode()].join(', '),
      });
    }, longPredictionWarning);

    // Maps of source names to the latest metadata we got for them. This is
    // used to get around an issue with the CodeSearchStrategy, which discovers
    // _all_ sourcemap declarations for a given file, even though we only want
    // to follow the last one. (Webpack re-bundling compiled code can result in
    // multiple sourcemap comments per file, for example.)
    const latestForCompiled = new Map<string, { i: number; discovered: DiscoveredMetadata[] }>();
    let counter = 0;

    try {
      await this.repo.streamChildrenWithSourcemaps(this.outFiles, async metadata => {
        const i = counter++;
        const discovered: DiscoveredMetadata[] = [];
        const nowInvalid = latestForCompiled.get(metadata.compiledPath);
        if (nowInvalid) {
          for (const discovery of nowInvalid.discovered) {
            sourcePathToCompiled.get(discovery.resolvedPath)?.delete(discovery);
          }
        }
        latestForCompiled.set(metadata.compiledPath, { i, discovered });

        const cached = await this.cache?.lookup(metadata.compiledPath, metadata.cacheKey);
        if (cached) {
          discovered.push(...cached.map(c => ({ ...c, ...metadata })));
        } else {
          let map: SourceMap;
          try {
            map = await this.sourceMapFactory.load(metadata);
          } catch {
            return;
          }

          for (const url of map.sources) {
            const resolvedPath = this.sourcePathResolver
              ? await this.sourcePathResolver.urlToAbsolutePath({ url, map })
              : urlUtils.fileUrlToAbsolutePath(url);

            if (!resolvedPath) {
              continue;
            }

            discovered.push({ ...metadata, resolvedPath, sourceUrl: url });
          }
        }

        // Double check that this is still the latest sourcemap we got for this
        // file before finalizing the discoveries.
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        if (latestForCompiled.get(metadata.compiledPath)!.i !== i) {
          return;
        }

        discovered.forEach(addDiscovery);

        this.cache?.store(
          metadata.compiledPath,
          metadata.cacheKey,
          discovered.map(d => ({ resolvedPath: d.resolvedPath, sourceUrl: d.sourceUrl })),
        );
      });
    } catch (error) {
      this.logger.warn(LogTag.RuntimeException, 'Error reading sourcemaps from disk', { error });
    }

    clearTimeout(warnLongRuntime);
    return sourcePathToCompiled;
  }

  /**
   * @inheritdoc
   */
  public async prepareToPredict(): Promise<void> {
    if (!this.sourcePathToCompiled) {
      this.sourcePathToCompiled = this.createInitialMapping();
    }

    await this.sourcePathToCompiled;
  }

  /**
   * Returns a promise that resolves when breakpoints for the given location
   * are predicted.
   */
  public async predictBreakpoints(params: Dap.SetBreakpointsParams): Promise<void> {
    if (!params.source.path || !params.breakpoints?.length) {
      return;
    }

    if (!this.sourcePathToCompiled) {
      this.sourcePathToCompiled = this.createInitialMapping();
    }

    const sourcePathToCompiled = await this.sourcePathToCompiled;
    const topLevel = sourcePathToCompiled.get(params.source.path);
    if (!topLevel) {
      return;
    }

    const addSourceMapLocations = async (
      line: number,
      col: number,
      metadata: DiscoveredMetadata,
    ): Promise<IWorkspaceLocation[]> => {
      const map = await this.sourceMapFactory.load(metadata);
      const entry = this.sourceMapFactory.guardSourceMapFn(
        map,
        () =>
          getOptimalCompiledPosition(
            metadata.sourceUrl,
            {
              lineNumber: line,
              columnNumber: col || 1,
            },
            map,
          ),
        () => null,
      );

      if (!entry || entry.line === null) {
        return [];
      }

      const nested = sourcePathToCompiled.get(metadata.compiledPath);
      if (nested) {
        const n = await Promise.all(
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          [...nested].map(n => addSourceMapLocations(entry.line!, entry.column!, n)),
        );
        return n.flat();
      }

      return [
        {
          absolutePath: metadata.compiledPath,
          lineNumber: entry.line || 1,
          columnNumber: entry.column ? entry.column + 1 : 1,
        },
      ];
    };

    for (const b of params.breakpoints ?? []) {
      const key = `${params.source.path}:${b.line}:${b.column || 1}`;
      if (this.predictedLocations.has(key)) {
        return;
      }

      const locations: IWorkspaceLocation[] = [];
      this.predictedLocations.set(key, locations);

      for (const metadata of topLevel) {
        locations.push(...(await addSourceMapLocations(b.line, b.column || 0, metadata)));
      }
    }
  }

  /**
   * @inheritdoc
   */
  public async getPredictionForSource(sourcePath: string) {
    if (!this.sourcePathToCompiled) {
      this.sourcePathToCompiled = this.createInitialMapping();
    }

    const sourcePathToCompiled = await this.sourcePathToCompiled;
    return sourcePathToCompiled.get(sourcePath);
  }

  /**
   * Returns predicted breakpoint locations for the provided source.
   */
  public predictedResolvedLocations(location: IWorkspaceLocation): IWorkspaceLocation[] {
    const key = `${location.absolutePath}:${location.lineNumber}:${location.columnNumber || 1}`;
    return this.predictedLocations.get(key) ?? [];
  }
}
