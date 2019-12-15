/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as path from 'path';
import Dap from '../dap/api';
import * as urlUtils from '../common/urlUtils';
import * as sourceUtils from '../common/sourceUtils';
import { InlineScriptOffset, ISourcePathResolver } from '../common/sourcePathResolver';
import { uiToRawOffset } from './sources';
import { ISourceMapRepository } from '../common/sourceMaps/sourceMapRepository';
import { ISourceMapMetadata } from '../common/sourceMaps/sourceMap';
import { SourceMapConsumer } from 'source-map';
import { MapUsingProjection } from '../common/datastructure/mapUsingProjection';
import { CorrelatedCache } from '../common/sourceMaps/mtimeCorrelatedCache';
import { logger } from '../common/logging/logger';
import { LogTag } from '../common/logging';

// TODO: kNodeScriptOffset and every "+/-1" here are incorrect. We should use "defaultScriptOffset".
const kNodeScriptOffset: InlineScriptOffset = { lineOffset: 0, columnOffset: 62 };

export interface IWorkspaceLocation {
  absolutePath: string;
  lineNumber: number; // 1-based
  columnNumber: number; // 1-based
}

type PredictedLocation = {
  source: IWorkspaceLocation;
  compiled: IWorkspaceLocation;
};

export type BreakpointPredictionCache = CorrelatedCache<number, DiscoveredMetadata[]>;

export class BreakpointsPredictor {
  _rootPath: string;
  private _directoryScanners = new Map<string, DirectoryScanner>();
  _predictedLocations: PredictedLocation[] = [];
  _sourcePathResolver?: ISourcePathResolver;

  constructor(
    rootPath: string,
    private readonly repo: ISourceMapRepository,
    sourcePathResolver: ISourcePathResolver | undefined,
    private readonly cache: BreakpointPredictionCache | undefined,
  ) {
    this._rootPath = rootPath;
    this._sourcePathResolver = sourcePathResolver;
  }

  /**
   * Returns a promise that resolves once maps in the root are predicted.
   */
  public async prepareToPredict(): Promise<void> {
    await this._directoryScanner(this._rootPath).waitForLoad();
  }

  /**
   * Returns a promise that resolves when breakpoints for the given location
   * are predicted.
   */
  public predictBreakpoints(params: Dap.SetBreakpointsParams): Promise<void> {
    if (!params.source.path) {
      return Promise.resolve();
    }

    let root = this._rootPath;

    // fast check to see if we need to take this path:
    if (params.source.path.includes('node_modules')) {
      // if we're in a node module, resolve everything in the module folder
      let moduleRoot = params.source.path;
      while (true) {
        const nextDir = path.dirname(moduleRoot);

        // we reached the filesystem root? Use the default root path.
        if (nextDir === moduleRoot) {
          break;
        }

        // if the next directory is node_modules or a @package scope, we
        // reached the module root.
        const nextBase = path.basename(nextDir);
        if (nextBase === 'node_modules' || nextBase.startsWith('@')) {
          root = moduleRoot;
          break;
        }

        moduleRoot = nextDir;
      }
    }

    return this._directoryScanner(root).predictResolvedLocations(params);
  }

  /**
   * Returns predicted breakpoint locations for the provided source.
   */
  public predictedResolvedLocations(location: IWorkspaceLocation): IWorkspaceLocation[] {
    const result: IWorkspaceLocation[] = [];
    for (const p of this._predictedLocations) {
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

  private _directoryScanner(root: string): DirectoryScanner {
    let result = this._directoryScanners.get(root);
    if (!result) {
      result = new DirectoryScanner(this, this.repo, root, this.cache);
      this._directoryScanners.set(root, result);
    }
    return result;
  }
}

type DiscoveredMetadata = ISourceMapMetadata & { sourceUrl: string; resolvedPath: string };
type MetadataMap = Map<string, Set<DiscoveredMetadata>>;

const defaultFileMappings = ['**/*.js', '!**/node_modules/**'];
const longPredictionWarning = 10 * 1000;

class DirectoryScanner {
  private _predictor: BreakpointsPredictor;
  private _sourcePathToCompiled: Promise<MetadataMap>;

  constructor(
    predictor: BreakpointsPredictor,
    private readonly repo: ISourceMapRepository,
    root: string,
    cache?: BreakpointPredictionCache,
  ) {
    this._predictor = predictor;
    this._sourcePathToCompiled = this._createInitialMapping(root, cache);
  }

  private async _createInitialMapping(absolutePath: string, cache?: BreakpointPredictionCache) {
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
      logger.warn(LogTag.RuntimeSourceMap, 'Long breakpoint predictor runtime', {
        longPredictionWarning,
        absolutePath,
      });
    }, longPredictionWarning);

    const start = Date.now();
    await this.repo.streamAllChildren(absolutePath, defaultFileMappings, async metadata => {
      const baseUrl = metadata.sourceMapUrl.startsWith('data:')
        ? metadata.compiledPath
        : metadata.sourceMapUrl;

      const cached = cache && (await cache.lookup(metadata.compiledPath, metadata.mtime));
      if (cached) {
        cached.forEach(addDiscovery);
        return;
      }

      const map = await sourceUtils.loadSourceMap(metadata);
      if (!map) {
        return;
      }

      const discovered: DiscoveredMetadata[] = [];
      for (const url of map.sources) {
        const sourceUrl = urlUtils.maybeAbsolutePathToFileUrl(this._predictor._rootPath, url);
        const resolvedUrl = urlUtils.completeUrlEscapingRoot(baseUrl, sourceUrl);
        const resolvedPath = this._predictor._sourcePathResolver
          ? this._predictor._sourcePathResolver.urlToAbsolutePath({ url: resolvedUrl, map })
          : urlUtils.fileUrlToAbsolutePath(resolvedUrl);

        if (!resolvedPath) {
          continue;
        }

        const discovery = { ...metadata, resolvedPath, sourceUrl: url };
        discovered.push(discovery);
        addDiscovery(discovery);
      }

      if (cache) {
        cache.store(metadata.compiledPath, metadata.mtime, discovered);
      }
    });

    clearTimeout(warnLongRuntime);
    logger.verbose(LogTag.SourceMapParsing, 'Breakpoint prediction completed', {
      type: this.repo.constructor.name,
      duration: Date.now() - start,
      absolutePath,
    });

    return sourcePathToCompiled;
  }

  /**
   * Returns a promise that resolves when the sourcemaps predictions are
   * successfully prepared.
   */
  public async waitForLoad() {
    await this._sourcePathToCompiled;
  }

  public async predictResolvedLocations(params: Dap.SetBreakpointsParams) {
    const sourcePathToCompiled = await this._sourcePathToCompiled;
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

      const map = await sourceUtils.loadSourceMap(metadata);
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

        const { lineNumber, columnNumber } = uiToRawOffset(
          { lineNumber: entry.line || 1, columnNumber: entry.column ? entry.column + 1 : 1 },
          kNodeScriptOffset,
        );
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
        this._predictor._predictedLocations.push(predicted);
      }
    }
  }
}
