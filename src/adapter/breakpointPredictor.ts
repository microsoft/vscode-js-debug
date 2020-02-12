/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as path from 'path';
import Dap from '../dap/api';
import * as urlUtils from '../common/urlUtils';
import { ISourcePathResolver } from '../common/sourcePathResolver';
import { ISourceMapRepository } from '../common/sourceMaps/sourceMapRepository';
import { ISourceMapMetadata } from '../common/sourceMaps/sourceMap';
import { SourceMapConsumer } from 'source-map';
import { MapUsingProjection } from '../common/datastructure/mapUsingProjection';
import { CorrelatedCache } from '../common/sourceMaps/mtimeCorrelatedCache';
import { LogTag, ILogger } from '../common/logging';
import { AnyLaunchConfiguration } from '../configuration';
import { EventEmitter } from '../common/events';
import { ISourceMapFactory } from '../common/sourceMaps/sourceMapFactory';
import { logPerf } from '../telemetry/performance';
import { injectable, inject } from 'inversify';

export interface IWorkspaceLocation {
  absolutePath: string;
  lineNumber: number; // 1-based
  columnNumber: number; // 1-based
}

type PredictedLocation = {
  source: IWorkspaceLocation;
  compiled: IWorkspaceLocation;
};

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

@injectable()
export class BreakpointsPredictor implements IBreakpointsPredictor {
  private readonly predictedLocations: PredictedLocation[] = [];
  private readonly patterns: string[];
  private readonly rootPath: string;
  private readonly longParseEmitter = new EventEmitter<void>();
  private sourcePathToCompiled?: Promise<MetadataMap>;
  private cache?: CorrelatedCache<number, DiscoveredMetadata[]>;

  /**
   * Event that fires if it takes a long time to predict sourcemaps.
   */
  public readonly onLongParse = this.longParseEmitter.event;

  constructor(
    @inject(AnyLaunchConfiguration) launchConfig: AnyLaunchConfiguration,
    @inject(ISourceMapRepository) private readonly repo: ISourceMapRepository,
    @inject(ILogger) private readonly logger: ILogger,
    @inject(ISourceMapFactory) private readonly sourceMapFactory: ISourceMapFactory,
    @inject(ISourcePathResolver)
    private readonly sourcePathResolver: ISourcePathResolver | undefined,
  ) {
    this.rootPath = launchConfig.rootPath;
    this.patterns = launchConfig.outFiles.map(p =>
      path.isAbsolute(p) ? path.relative(launchConfig.rootPath, p) : p,
    );

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
    if (this.patterns.length === 0) {
      return new Map();
    }

    if (!this.rootPath) {
      return new Map();
    }

    const sourcePathToCompiled: MetadataMap = new MapUsingProjection(
      urlUtils.lowerCaseInsensitivePath,
    );
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
        patterns: this.patterns,
      });
    }, longPredictionWarning);

    await this.repo.streamAllChildren(this.rootPath, this.patterns, async metadata => {
      const cached = await this.cache?.lookup(metadata.compiledPath, metadata.mtime);
      if (cached) {
        cached.forEach(addDiscovery);
        return;
      }

      const map = await this.sourceMapFactory.load(metadata);
      if (!map) {
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
    if (!params.source.path) {
      return Promise.resolve();
    }
    if (!this.sourcePathToCompiled) {
      this.sourcePathToCompiled = this.createInitialMapping();
    }

    const sourcePathToCompiled = await this.sourcePathToCompiled;
    const absolutePath = params.source.path;
    if (!absolutePath) {
      return;
    }

    const set = sourcePathToCompiled.get(absolutePath);

    if (!set) return;
    for (const metadata of set) {
      if (!metadata.compiledPath) {
        return;
      }

      const map = await this.sourceMapFactory.load(metadata);
      if (!map) {
        continue;
      }

      for (const b of params.breakpoints || []) {
        const entry = map.generatedPositionFor({
          source: metadata.sourceUrl,
          line: b.line,
          column: b.column || 1,
          bias: SourceMapConsumer.LEAST_UPPER_BOUND,
        });
        if (entry.line === null) {
          continue;
        }

        const { lineNumber, columnNumber } = {
          lineNumber: entry.line || 1,
          columnNumber: entry.column ? entry.column + 1 : 1,
        };
        const predicted: PredictedLocation = {
          source: {
            absolutePath,
            lineNumber: b.line,
            columnNumber: b.column || 1,
          },
          compiled: {
            absolutePath: metadata.compiledPath,
            lineNumber,
            columnNumber,
          },
        };
        this.predictedLocations.push(predicted);
      }
    }
  }

  /**
   * Returns predicted breakpoint locations for the provided source.
   */
  public predictedResolvedLocations(location: IWorkspaceLocation): IWorkspaceLocation[] {
    const result: IWorkspaceLocation[] = [];
    for (const p of this.predictedLocations) {
      if (
        p.source.absolutePath === location.absolutePath &&
        p.source.lineNumber === location.lineNumber &&
        p.source.columnNumber === location.columnNumber
      ) {
        result.push(p.compiled);
      }
    }
    return result;
  }
}
