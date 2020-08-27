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
  private cache?: CorrelatedCache<number, DiscoveredMetadata[]>;

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
        patterns: this.outFiles.patterns,
      });
    }, longPredictionWarning);

    try {
      await this.repo.streamChildrenWithSourcemaps(this.outFiles, async metadata => {
        const cached = await this.cache?.lookup(metadata.compiledPath, metadata.mtime);
        if (cached) {
          cached.forEach(addDiscovery);
          return;
        }

        let map: SourceMap;
        try {
          map = await this.sourceMapFactory.load(metadata);
        } catch {
          return;
        }

        const discovered: DiscoveredMetadata[] = [];
        for (const url of map.sources) {
          const resolvedPath = this.sourcePathResolver
            ? await this.sourcePathResolver.urlToAbsolutePath({ url, map })
            : urlUtils.fileUrlToAbsolutePath(url);

          if (!resolvedPath) {
            continue;
          }

          const discovery = { ...metadata, resolvedPath, sourceUrl: url };
          discovered.push(discovery);
          addDiscovery(discovery);
        }

        this.cache?.store(metadata.compiledPath, metadata.mtime, discovered);
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

    const set = (await this.sourcePathToCompiled).get(params.source.path);
    if (!set) {
      return;
    }

    const sourceMaps = await Promise.all(
      [...set].map(metadata =>
        this.sourceMapFactory
          .load(metadata)
          .then(map => ({ map, metadata }))
          .catch(() => undefined),
      ),
    );

    for (const b of params.breakpoints ?? []) {
      const key = `${params.source.path}:${b.line}:${b.column || 1}`;
      if (this.predictedLocations.has(key)) {
        return;
      }

      const locations: IWorkspaceLocation[] = [];
      this.predictedLocations.set(key, locations);

      for (const sourceMapLoad of sourceMaps) {
        if (!sourceMapLoad) {
          continue;
        }

        const { map, metadata } = sourceMapLoad;
        const entry = getOptimalCompiledPosition(
          metadata.sourceUrl,
          {
            lineNumber: b.line,
            columnNumber: b.column || 1,
          },
          map,
        );

        if (entry.line === null) {
          continue;
        }

        locations.push({
          absolutePath: metadata.compiledPath,
          lineNumber: entry.line || 1,
          columnNumber: entry.column ? entry.column + 1 : 1,
        });
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

    return (await this.sourcePathToCompiled).get(sourcePath);
  }

  /**
   * Returns predicted breakpoint locations for the provided source.
   */
  public predictedResolvedLocations(location: IWorkspaceLocation): IWorkspaceLocation[] {
    const key = `${location.absolutePath}:${location.lineNumber}:${location.columnNumber || 1}`;
    return this.predictedLocations.get(key) ?? [];
  }
}
