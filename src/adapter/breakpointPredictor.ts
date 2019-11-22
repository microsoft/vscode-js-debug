// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as path from 'path';
import Dap from '../dap/api';
import * as urlUtils from '../common/urlUtils';
import * as sourceUtils from '../common/sourceUtils';
import * as fsUtils from '../common/fsUtils';
import { InlineScriptOffset, ISourcePathResolver } from '../common/sourcePathResolver';
import { uiToRawOffset } from './sources';
import { LocalSourceMapRepository } from '../common/sourceMaps/sourceMapRepository';
import { ISourceMapMetadata } from '../common/sourceMaps/sourceMap';
import { SourceMapConsumer } from 'source-map';
import { MapUsingProjection } from '../common/datastructure/mapUsingProjection';

// TODO: kNodeScriptOffset and every "+/-1" here are incorrect. We should use "defaultScriptOffset".
const kNodeScriptOffset: InlineScriptOffset = { lineOffset: 0, columnOffset: 62 };

export interface WorkspaceLocation {
  absolutePath: string;
  lineNumber: number; // 1-based
  columnNumber: number; // 1-based
}

type PredictedLocation = {
  source: WorkspaceLocation;
  compiled: WorkspaceLocation;
};

export class BreakpointsPredictor {
  _rootPath: string;
  private _nodeModules: Promise<string | undefined>;
  private _directoryScanners = new Map<string, DirectoryScanner>();
  _predictedLocations: PredictedLocation[] = [];
  _sourcePathResolver?: ISourcePathResolver;

  constructor(
    rootPath: string,
    private readonly repo: LocalSourceMapRepository,
    sourcePathResolver: ISourcePathResolver | undefined,
  ) {
    this._rootPath = rootPath;
    this._sourcePathResolver = sourcePathResolver;

    const nodeModules = path.join(this._rootPath, 'node_modules');
    this._nodeModules = fsUtils
      .exists(nodeModules)
      .then(exists => (exists ? nodeModules : undefined));
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
  public async predictBreakpoints(params: Dap.SetBreakpointsParams): Promise<void> {
    if (!params.source.path) return;
    const nodeModules = await this._nodeModules;
    let root: string;
    if (nodeModules && params.source.path.startsWith(nodeModules)) {
      root = path.relative(nodeModules, params.source.path);
      root = path.join(nodeModules, root.split(path.sep)[0]);
    } else {
      root = this._rootPath;
    }
    await this._directoryScanner(root).predictResolvedLocations(params);
  }

  /**
   * Returns predicted breakpoint locations for the provided source.
   */
  public predictedResolvedLocations(location: WorkspaceLocation): WorkspaceLocation[] {
    const result: WorkspaceLocation[] = [];
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
      result = new DirectoryScanner(this, this.repo, root);
      this._directoryScanners.set(root, result);
    }
    return result;
  }
}

type MetadataMap = Map<string, Set<ISourceMapMetadata & { sourceUrl: string }>>;

class DirectoryScanner {
  private _predictor: BreakpointsPredictor;
  private _sourcePathToCompiled: Promise<MetadataMap>;

  constructor(
    predictor: BreakpointsPredictor,
    private readonly repo: LocalSourceMapRepository,
    root: string,
  ) {
    this._predictor = predictor;
    this._sourcePathToCompiled = this._createInitialMapping(root);
  }

  private async _createInitialMapping(absolutePath: string) {
    const sourcePathToCompiled: MetadataMap = new MapUsingProjection(
      urlUtils.lowerCaseInsensitivePath,
    );
    for (const [, metadata] of Object.entries(await this.repo.findAllChildren(absolutePath))) {
      const baseUrl = metadata.sourceMapUrl.startsWith('data:')
        ? metadata.compiledPath
        : metadata.sourceMapUrl;

      const map = await sourceUtils.loadSourceMap(metadata);
      if (!map) {
        continue;
      }

      for (const url of map.sources) {
        const sourceUrl = urlUtils.maybeAbsolutePathToFileUrl(this._predictor._rootPath, url);
        const resolvedUrl = urlUtils.completeUrlEscapingRoot(baseUrl, sourceUrl);
        const resolvedPath = this._predictor._sourcePathResolver
          ? this._predictor._sourcePathResolver.urlToAbsolutePath({ url: resolvedUrl, map })
          : urlUtils.fileUrlToAbsolutePath(resolvedUrl);
        if (!resolvedPath) {
          continue;
        }

        let set = sourcePathToCompiled.get(resolvedPath);
        if (!set) {
          set = new Set();
          sourcePathToCompiled.set(resolvedPath, set);
        }
        set.add({ ...metadata, sourceUrl: url });
      }
    }

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
    const absolutePath = params.source.path!;
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
