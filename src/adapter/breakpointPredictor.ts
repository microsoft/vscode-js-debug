/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { promises as fs } from 'fs';
import { inject, injectable } from 'inversify';
import * as path from 'path';
import { Event } from 'vscode';
import { EventEmitter } from '../common/events';
import { OutFiles } from '../common/fileGlobList';
import { ILogger, LogTag } from '../common/logging';
import { fixDriveLetterAndSlashes } from '../common/pathUtils';
import { ISourceMapMetadata } from '../common/sourceMaps/sourceMap';
import { ISourceMapFactory } from '../common/sourceMaps/sourceMapFactory';
import { ISearchStrategy, ISourcemapStreamOptions } from '../common/sourceMaps/sourceMapRepository';
import { ISourcePathResolver } from '../common/sourcePathResolver';
import { getOptimalCompiledPosition, parseSourceMappingUrl } from '../common/sourceUtils';
import * as urlUtils from '../common/urlUtils';
import { AnyLaunchConfiguration } from '../configuration';
import Dap from '../dap/api';
import { logPerf } from '../telemetry/performance';

export interface IWorkspaceLocation {
  absolutePath: string;
  lineNumber: number; // 1-based
  columnNumber: number; // 1-based
}

// Symbol we we use to keep the inline source map URL in DisoveredMetadata that
// we create in _this_ session. We have it as a symbol since we don't want to
// serialize it.
const InlineSourceMapUrl = Symbol('InlineSourceMapUrl');

type DiscoveredMetadata = Omit<ISourceMapMetadata, 'sourceMapUrl'> & {
  sourceMapUrl: { [InlineSourceMapUrl]: string } | string;
  sourceUrl: string;
  resolvedPath: string;
};
type MetadataMap = Map<string, Set<DiscoveredMetadata>>;

const longPredictionWarning = 10 * 1000;

@injectable()
export class BreakpointPredictorCachedState<T> {
  private value: T | undefined;
  private readonly path?: string;

  constructor(@inject(AnyLaunchConfiguration) launchConfig: AnyLaunchConfiguration) {
    if (launchConfig.__workspaceCachePath) {
      this.path = path.join(launchConfig.__workspaceCachePath, 'bp-predict.json');
    }
  }

  public async load(): Promise<T | undefined> {
    if (this.value || !this.path) {
      return this.value;
    }

    try {
      this.value = JSON.parse(await fs.readFile(this.path, 'utf-8'));
    } catch {
      // ignored
    }

    return this.value;
  }

  public async store(value: T) {
    this.value = value;
    if (this.path) {
      await fs.mkdir(path.dirname(this.path), { recursive: true });
      await fs.writeFile(this.path, JSON.stringify(value));
    }
  }
}

@injectable()
export abstract class BreakpointSearch {
  constructor(
    @inject(OutFiles) private readonly outFiles: OutFiles,
    @inject(ISearchStrategy) private readonly repo: ISearchStrategy,
    @inject(ILogger) protected readonly logger: ILogger,
    @inject(ISourceMapFactory) private readonly sourceMapFactory: ISourceMapFactory,
    @inject(ISourcePathResolver) private readonly sourcePathResolver:
      | ISourcePathResolver
      | undefined,
    @inject(BreakpointPredictorCachedState) private readonly state: BreakpointPredictorCachedState<
      unknown
    >,
  ) {}

  public abstract getMetadataForPaths(
    sourcePaths: readonly string[],
  ): Promise<(Set<DiscoveredMetadata> | undefined)[]>;

  protected async createMapping(
    opts?: Partial<
      ISourcemapStreamOptions<{ discovered: DiscoveredMetadata[]; compiledPath: string }, void>
    >,
  ): Promise<MetadataMap> {
    if (this.outFiles.empty) {
      return new Map();
    }

    const sourcePathToCompiled: MetadataMap = urlUtils.caseNormalizedMap();
    const cachedState = await this.state.load();

    try {
      const { state } = await this.repo.streamChildrenWithSourcemaps<
        { discovered: DiscoveredMetadata[]; compiledPath: string },
        void
      >({
        files: this.outFiles,
        processMap: async metadata => {
          const discovered: DiscoveredMetadata[] = [];
          const map = await this.sourceMapFactory.load(metadata);
          for (const url of map.sources) {
            if (url === null) {
              continue;
            }

            const resolvedPath = this.sourcePathResolver
              ? await this.sourcePathResolver.urlToAbsolutePath({ url, map })
              : urlUtils.fileUrlToAbsolutePath(url);

            if (!resolvedPath) {
              continue;
            }

            discovered.push({
              ...metadata,
              sourceMapUrl: urlUtils.isDataUri(metadata.sourceMapUrl)
                ? { [InlineSourceMapUrl]: metadata.sourceMapUrl }
                : metadata.sourceMapUrl,
              resolvedPath,
              sourceUrl: url,
            });
          }

          return { discovered, compiledPath: fixDriveLetterAndSlashes(metadata.compiledPath) };
        },
        onProcessedMap: ({ discovered }) => {
          for (const discovery of discovered) {
            let set = sourcePathToCompiled.get(discovery.resolvedPath);
            if (!set) {
              set = new Set();
              sourcePathToCompiled.set(discovery.resolvedPath, set);
            }

            set.add(discovery);
          }
        },
        lastState: cachedState,
        ...opts,
      });

      // don't await, we can return early
      if (state) {
        this.state
          .store(state)
          .catch(e =>
            this.logger.warn(LogTag.RuntimeException, 'Error saving sourcemap cache', {
              error: e,
            })
          );
      }
    } catch (error) {
      this.logger.warn(LogTag.RuntimeException, 'Error reading sourcemaps from disk', { error });
    }

    return sourcePathToCompiled;
  }
}

@injectable()
export class GlobalBreakpointSearch extends BreakpointSearch {
  private sourcePathToCompiled?: Promise<MetadataMap>;

  /**
   * @inheritdoc
   */
  public override async getMetadataForPaths(sourcePaths: readonly string[]) {
    if (!this.sourcePathToCompiled) {
      this.sourcePathToCompiled = this.createInitialMapping();
    }

    const sourcePathToCompiled = await this.sourcePathToCompiled;
    return sourcePaths.map(p => sourcePathToCompiled.get(p));
  }

  private async createInitialMapping(): Promise<MetadataMap> {
    return logPerf(
      this.logger,
      `BreakpointsPredictor.createInitialMapping`,
      () => this.createMapping(),
    );
  }
}

/**
 * Breakpoint search that only
 */
@injectable()
export class TargetedBreakpointSearch extends BreakpointSearch {
  private readonly sourcePathToCompiled = new Map<string, Promise<MetadataMap>>();

  /**
   * @inheritdoc
   */
  public override async getMetadataForPaths(sourcePaths: readonly string[]) {
    const existing = sourcePaths.map(sp => this.sourcePathToCompiled.get(sp));
    const toFind = sourcePaths.map((_, i) => i).filter(i => !existing[i]);

    // if some paths have not been found yet, do one operation to find all of them
    if (toFind.length) {
      const spSet = new Set(toFind.map(i => fixDriveLetterAndSlashes(sourcePaths[i])));
      const entry = this.createMapping({
        filter: (_, meta) => !meta || meta.discovered.some(d => spSet.has(d.resolvedPath)),
      });
      for (const i of toFind) {
        this.sourcePathToCompiled.set(sourcePaths[i], entry);
        existing[i] = entry;
      }
    }

    const r = await Promise.all(
      existing.map(async (entry, i) => {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const map: MetadataMap = await entry!;
        return map.get(sourcePaths[i]);
      }),
    );

    return r;
  }
}

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
  private readonly predictedLocations = new Map<string, IWorkspaceLocation[]>();
  private readonly longParseEmitter = new EventEmitter<void>();

  /**
   * If set, when asked for breakpoints for a path, the breakpoint predictor
   * will not re-scan all files, but only look at new files or files where
   * it's known a given source correlated to.
   */
  public targetedMode = false;

  /**
   * Event that fires if it takes a long time to predict sourcemaps.
   */
  public readonly onLongParse = this.longParseEmitter.event;

  constructor(
    @inject(BreakpointSearch) private readonly bpSearch: BreakpointSearch,
    @inject(OutFiles) private readonly outFiles: OutFiles,
    @inject(ILogger) private readonly logger: ILogger,
    @inject(ISourceMapFactory) private readonly sourceMapFactory: ISourceMapFactory,
  ) {}
  /**
   * Returns a promise that resolves when breakpoints for the given location
   * are predicted.
   */
  public async predictBreakpoints(params: Dap.SetBreakpointsParams): Promise<void> {
    if (!params.source.path || !params.breakpoints?.length) {
      return;
    }

    const topLevel = await this.getMetadataForPaths([params.source.path]).then(m => m[0]);
    if (!topLevel) {
      return;
    }

    const addSourceMapLocations = async (
      line: number,
      col: number,
      metadata: DiscoveredMetadata,
    ): Promise<IWorkspaceLocation[]> => {
      const sourceMapUrl = typeof metadata.sourceMapUrl === 'string'
        ? metadata.sourceMapUrl
        : metadata.sourceMapUrl.hasOwnProperty(InlineSourceMapUrl)
        ? metadata.sourceMapUrl[InlineSourceMapUrl]
        : await fs.readFile(metadata.compiledPath, 'utf8').then(parseSourceMappingUrl);

      if (!sourceMapUrl) {
        return [];
      }

      const map = await this.sourceMapFactory.load({ ...metadata, sourceMapUrl });
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

      const nested = await this.getMetadataForPaths([metadata.compiledPath]).then(m => m[0]);
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
    return this.getMetadataForPaths([sourcePath]).then(m => m[0]);
  }

  private async getMetadataForPaths(sourcePaths: readonly string[]) {
    const warnLongRuntime = setTimeout(() => {
      this.longParseEmitter.fire();
      this.logger.warn(LogTag.RuntimeSourceMap, 'Long breakpoint predictor runtime', {
        longPredictionWarning,
        patterns: [...this.outFiles.explode()].join(', '),
      });
    }, longPredictionWarning);

    const result = await this.bpSearch.getMetadataForPaths(sourcePaths);

    clearTimeout(warnLongRuntime);

    return result;
  }

  /**
   * Returns predicted breakpoint locations for the provided source.
   */
  public predictedResolvedLocations(location: IWorkspaceLocation): IWorkspaceLocation[] {
    const key = `${location.absolutePath}:${location.lineNumber}:${location.columnNumber || 1}`;
    return this.predictedLocations.get(key) ?? [];
  }
}
