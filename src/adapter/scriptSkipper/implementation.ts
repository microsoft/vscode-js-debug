/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { inject, injectable } from 'inversify';
import micromatch from 'micromatch';
import { Cdp } from '../../cdp/api';
import { ICdpApi } from '../../cdp/connection';
import { MapUsingProjection } from '../../common/datastructure/mapUsingProjection';
import { EventEmitter } from '../../common/events';
import { ILogger, LogTag } from '../../common/logging';
import { node15InternalsPrefix } from '../../common/node15Internal';
import { memoizeLast, trailingEdgeThrottle, truthy } from '../../common/objUtils';
import * as pathUtils from '../../common/pathUtils';
import { getDeferred, IDeferred } from '../../common/promiseUtil';
import { escapeRegexSpecialChars } from '../../common/stringUtils';
import * as urlUtils from '../../common/urlUtils';
import { AnyLaunchConfiguration } from '../../configuration';
import Dap from '../../dap/api';
import { ITarget } from '../../targets/targets';
import {
  ISourceWithMap,
  isSourceWithMap,
  Source,
  SourceContainer,
  SourceFromMap,
} from '../sources';
import { getSourceSuffix } from '../templates';
import { simpleGlobsToRe } from './simpleGlobToRe';

interface ISharedSkipToggleEvent {
  rootTargetId: string;
  targetId: string;
  params: Dap.ToggleSkipFileStatusParams;
}

function preprocessNodeInternals(userSkipPatterns: ReadonlyArray<string>): string[] | undefined {
  const nodeInternalRegex = /^<node_internals>[\/\\](.*)$/;

  const nodeInternalPatterns = userSkipPatterns
    .map(userPattern => {
      userPattern = userPattern.trim();
      const nodeInternalPattern = nodeInternalRegex.exec(userPattern);
      return nodeInternalPattern ? nodeInternalPattern[1] : null;
    })
    .filter(truthy);

  return nodeInternalPatterns.length > 0 ? nodeInternalPatterns : undefined;
}

function preprocessAuthoredGlobs(userSkipPatterns: ReadonlyArray<string>): string[] {
  const authoredGlobs = userSkipPatterns
    .filter(pattern => !pattern.includes('<node_internals>'))
    .map(pattern =>
      urlUtils.isAbsolute(pattern)
        ? urlUtils.absolutePathToFileUrl(pattern)
        : pathUtils.forceForwardSlashes(pattern),
    )
    .map(urlUtils.lowerCaseInsensitivePath);

  return authoredGlobs;
}

@injectable()
export class ScriptSkipper {
  private static sharedSkipsEmitter = new EventEmitter<ISharedSkipToggleEvent>();

  /**
   * Globs for non-<node_internals> skipfiles. This might be changed over time
   * if the user uses the "toggle skipping this file" command.
   */
  private _authoredGlobs: readonly string[];

  /** Memoized computer for non-<node_internals> skipfiles */
  private _regexForAuthored = memoizeLast(simpleGlobsToRe);

  /**
   * Globs for node internals. These are treated specially, at least until we
   * drop support for Node <=14, since in Node 15 the internals all have a
   * `node:` prefix that we can match against.
   */
  private _nodeInternalsGlobs: string[] | undefined;

  /** Set of all internal modules, read from the runtime */
  private _allNodeInternals?: IDeferred<ReadonlySet<string>>;

  /**
   * Mapping of URLs from sourcemaps to a boolean indicating whether they're
   * skipped. These are kept and used in addition to the authoredGlobs, since
   * if a compiled file is skipped, we want to skip the sourcemapped sources
   * as well.
   */
  private _isUrlFromSourceMapSkipped: Map<string, boolean>;

  /**
   * A set of script ID that have one or more skipped ranges in them. Mostly
   * used to avoid unnecessarily sending skip data for new scripts.
   */
  private _scriptsWithSkipping = new Set<string>();

  private _sourceContainer!: SourceContainer;
  private _updateSkippedDebounce: () => void;
  private _targetId: string;
  private _rootTargetId: string;

  constructor(
    @inject(AnyLaunchConfiguration) { skipFiles }: AnyLaunchConfiguration,
    @inject(ILogger) private readonly logger: ILogger,
    @inject(ICdpApi) private readonly cdp: Cdp.Api,
    @inject(ITarget) target: ITarget,
  ) {
    this._targetId = target.id();
    this._rootTargetId = getRootTarget(target).id();
    this._isUrlFromSourceMapSkipped = new MapUsingProjection<string, boolean>(key =>
      this._normalizeUrl(key),
    );

    this._authoredGlobs = preprocessAuthoredGlobs(skipFiles);
    this._nodeInternalsGlobs = preprocessNodeInternals(skipFiles);

    this._initNodeInternals(target); // Purposely don't wait, no need to slow things down
    this._updateSkippedDebounce = trailingEdgeThrottle(500, () =>
      this._updateGeneratedSkippedSources(),
    );

    if (skipFiles.length) {
      this._updateGeneratedSkippedSources();
    }

    ScriptSkipper.sharedSkipsEmitter.event(e => {
      if (e.rootTargetId === this._rootTargetId && e.targetId !== this._targetId) {
        this._toggleSkippingFile(e.params);
      }
    });
  }

  public setSourceContainer(sourceContainer: SourceContainer): void {
    this._sourceContainer = sourceContainer;
  }

  private _testSkipNodeInternal(testString: string): boolean {
    if (!this._nodeInternalsGlobs) {
      return false;
    }

    if (testString.startsWith(node15InternalsPrefix)) {
      testString = testString.slice(node15InternalsPrefix.length);
    }

    return micromatch([testString], this._nodeInternalsGlobs).length > 0;
  }

  private _testSkipAuthored(testString: string): boolean {
    return this._regexForAuthored(this._authoredGlobs).some(re => re.test(testString));
  }

  private _isNodeInternal(url: string, nodeInternals: ReadonlySet<string> | undefined): boolean {
    if (url.startsWith(node15InternalsPrefix)) {
      return true;
    }

    return nodeInternals?.has(url) || /^internal\/.+\.js$/.test(url);
  }

  private async _updateGeneratedSkippedSources(): Promise<void> {
    const patterns: string[] = this._regexForAuthored(this._authoredGlobs).map(re => re.source);

    const nodeInternals = this._allNodeInternals?.settledValue;
    if (nodeInternals) {
      patterns.push(`^(${node15InternalsPrefix})?internal\\/`);
      for (const internal of nodeInternals) {
        if (this._testSkipNodeInternal(internal)) {
          patterns.push(`^(${node15InternalsPrefix})?${escapeRegexSpecialChars(internal)}$`);
        }
      }
    }

    await this.cdp.Debugger.setBlackboxPatterns({ patterns });
  }

  private _normalizeUrl(url: string): string {
    return pathUtils.forceForwardSlashes(url.toLowerCase());
  }

  /**
   * Gets whether the script at the URL is skipped.
   */
  public isScriptSkipped(url: string): boolean {
    if (this._isNodeInternal(url, this._allNodeInternals?.settledValue)) {
      return this._testSkipNodeInternal(url);
    }

    url = this._normalizeUrl(url);
    if (this._isUrlFromSourceMapSkipped.get(url) === true) {
      return true;
    }

    return this._testSkipAuthored(this._normalizeUrl(url));
  }

  private async _updateSourceWithSkippedSourceMappedSources(
    source: ISourceWithMap,
    scriptIds: Cdp.Runtime.ScriptId[],
  ): Promise<void> {
    // Order "should" be correct
    const parentIsSkipped = this.isScriptSkipped(source.url);
    const skipRanges: Cdp.Debugger.ScriptPosition[] = [];
    let inSkipRange = parentIsSkipped;
    Array.from(source.sourceMap.sourceByUrl.values()).forEach(authoredSource => {
      let isSkippedSource = this.isScriptSkipped(authoredSource.url);
      if (typeof isSkippedSource === 'undefined') {
        // If not toggled or specified in launch config, inherit the parent's status
        isSkippedSource = parentIsSkipped;
      }

      if (isSkippedSource !== inSkipRange) {
        const locations = this._sourceContainer.currentSiblingUiLocations(
          { source: authoredSource, lineNumber: 1, columnNumber: 1 },
          source,
        );
        if (locations[0]) {
          skipRanges.push({
            lineNumber: locations[0].lineNumber - 1,
            columnNumber: locations[0].columnNumber - 1,
          });
          inSkipRange = !inSkipRange;
        } else {
          this.logger.error(
            LogTag.Internal,
            'Could not map script beginning for ' + authoredSource.sourceReference,
          );
        }
      }
    });

    let targets = scriptIds;
    if (!skipRanges.length) {
      targets = targets.filter(t => this._scriptsWithSkipping.has(t));
      targets.forEach(t => this._scriptsWithSkipping.delete(t));
    }

    await Promise.all(
      targets.map(scriptId =>
        this.cdp.Debugger.setBlackboxedRanges({ scriptId, positions: skipRanges }),
      ),
    );
  }

  public initializeSkippingValueForSource(source: Source) {
    this._initializeSkippingValueForSource(source);
  }

  private _initializeSkippingValueForSource(source: Source, scriptIds = source.scriptIds()) {
    const url = source.url;
    let skipped = this.isScriptSkipped(url);

    // Check if this source was mapped to a URL we should have skipped, but didn't (oops)
    // This can happen if the user skips absolute paths which are served from a different
    // place in the server.
    if (
      !skipped &&
      source.absolutePath &&
      this._testSkipAuthored(urlUtils.absolutePathToFileUrl(source.absolutePath))
    ) {
      this.setIsUrlBlackboxSkipped(url, true);
      skipped = true;
      this._updateSkippedDebounce();
    }

    if (isSourceWithMap(source)) {
      if (skipped) {
        // if compiled and skipped, also skip authored sources
        for (const authoredSource of source.sourceMap.sourceByUrl.values()) {
          this._isUrlFromSourceMapSkipped.set(authoredSource.url, true);
        }
      }

      for (const nestedSource of source.sourceMap.sourceByUrl.values()) {
        this._initializeSkippingValueForSource(nestedSource, scriptIds);
      }

      this._updateSourceWithSkippedSourceMappedSources(source, scriptIds);
    }
  }

  private async _initNodeInternals(target: ITarget): Promise<void> {
    if (target.type() !== 'node' || !this._nodeInternalsGlobs || this._allNodeInternals) {
      return;
    }

    const deferred = (this._allNodeInternals = getDeferred());
    const evalResult = await this.cdp.Runtime.evaluate({
      expression: "require('module').builtinModules" + getSourceSuffix(),
      returnByValue: true,
      includeCommandLineAPI: true,
    });

    if (evalResult && !evalResult.exceptionDetails) {
      deferred.resolve(new Set((evalResult.result.value as string[]).map(name => name + '.js')));
    } else {
      deferred.resolve(new Set());
    }

    await this._updateGeneratedSkippedSources(); // updates skips now that we loaded internals
  }

  private async _toggleSkippingFile(
    params: Dap.ToggleSkipFileStatusParams,
  ): Promise<Dap.ToggleSkipFileStatusResult> {
    let path: string | undefined = undefined;
    if (params.resource) {
      if (urlUtils.isAbsolute(params.resource)) {
        path = params.resource;
      }
    }

    const sourceParams: Dap.Source = { path: path, sourceReference: params.sourceReference };
    const source = this._sourceContainer.source(sourceParams);
    if (!source) {
      return {};
    }

    const newSkipValue = !this.isScriptSkipped(source.url);
    if (source instanceof SourceFromMap) {
      this._isUrlFromSourceMapSkipped.set(source.url, newSkipValue);

      // Changed the skip value for an authored source, update it for all its compiled sources
      const compiledSources = Array.from(source.compiledToSourceUrl.keys());
      await Promise.all(
        compiledSources.map(compiledSource =>
          this._updateSourceWithSkippedSourceMappedSources(
            compiledSource,
            compiledSource.scriptIds(),
          ),
        ),
      );
    } else {
      if (isSourceWithMap(source)) {
        // if compiled, get authored sources
        for (const authoredSource of source.sourceMap.sourceByUrl.values()) {
          this._isUrlFromSourceMapSkipped.set(authoredSource.url, newSkipValue);
        }
      }

      this.setIsUrlBlackboxSkipped(source.url, newSkipValue);
      await this._updateGeneratedSkippedSources();
    }

    return {};
  }

  /** Sets whether the URL is explicitly skipped in the blackbox patterns */
  private setIsUrlBlackboxSkipped(url: string, skipped: boolean) {
    const positive = url;
    const negative = `!${positive}`;

    const globs = this._authoredGlobs.filter(g => g !== positive && g !== negative);
    if (this._regexForAuthored(globs).some(r => r.test(url)) !== skipped) {
      globs.push(skipped ? positive : negative);
      this._regexForAuthored.clear();
    }
    this._authoredGlobs = globs;
  }

  public async toggleSkippingFile(
    params: Dap.ToggleSkipFileStatusParams,
  ): Promise<Dap.ToggleSkipFileStatusResult> {
    const result = await this._toggleSkippingFile(params);
    ScriptSkipper.sharedSkipsEmitter.fire({
      params,
      rootTargetId: this._rootTargetId,
      targetId: this._targetId,
    });
    return result;
  }
}

function getRootTarget(target: ITarget): ITarget {
  const parent = target.parent();
  if (parent) {
    return getRootTarget(parent);
  } else {
    return target;
  }
}
