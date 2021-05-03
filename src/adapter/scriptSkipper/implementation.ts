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
import { trailingEdgeThrottle } from '../../common/objUtils';
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

interface ISharedSkipToggleEvent {
  rootTargetId: string;
  targetId: string;
  params: Dap.ToggleSkipFileStatusParams;
}

@injectable()
export class ScriptSkipper {
  private static sharedSkipsEmitter = new EventEmitter<ISharedSkipToggleEvent>();

  private _nonNodeInternalGlobs: string[] | null = null;

  // filtering node internals
  private _nodeInternalsGlobs: string[] | null = null;
  private _allNodeInternals?: IDeferred<ReadonlySet<string>>; // only set by Node

  private _isUrlSkipped: Map<string, boolean>;
  private _isAuthoredUrlSkipped: Map<string, boolean>;

  private _updateSkippedDebounce: () => void;

  /**
   * A set of script ID that have one or more skipped ranges in them. Mostly
   * used to avoid unnecessarily sending skip data for new scripts.
   */
  private _scriptsWithSkipping = new Set<string>();

  private _sourceContainer!: SourceContainer;

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
    this._isUrlSkipped = new MapUsingProjection<string, boolean>(key => this._normalizeUrl(key));
    this._isAuthoredUrlSkipped = new MapUsingProjection<string, boolean>(key =>
      this._normalizeUrl(key),
    );

    this._preprocessNodeInternals(skipFiles);
    this._setRegexForNonNodeInternals(skipFiles);
    this._initNodeInternals(target); // Purposely don't wait, no need to slow things down
    this._updateSkippedDebounce = trailingEdgeThrottle(500, () =>
      this._updateGeneratedSkippedSources(),
    );

    ScriptSkipper.sharedSkipsEmitter.event(e => {
      if (e.rootTargetId === this._rootTargetId && e.targetId !== this._targetId) {
        this._toggleSkippingFile(e.params);
      }
    });
  }

  public setSourceContainer(sourceContainer: SourceContainer): void {
    this._sourceContainer = sourceContainer;
  }

  private _preprocessNodeInternals(userSkipPatterns: ReadonlyArray<string>): void {
    const nodeInternalRegex = /^<node_internals>[\/\\](.*)$/;

    const nodeInternalPatterns = userSkipPatterns
      .map(userPattern => {
        userPattern = userPattern.trim();
        const nodeInternalPattern = nodeInternalRegex.exec(userPattern);
        return nodeInternalPattern ? nodeInternalPattern[1] : null;
      })
      .filter(nonNullPattern => nonNullPattern) as string[];

    if (nodeInternalPatterns.length > 0) {
      this._nodeInternalsGlobs = nodeInternalPatterns;
    }
  }

  private _setRegexForNonNodeInternals(userSkipPatterns: ReadonlyArray<string>): void {
    const nonNodeInternalGlobs = userSkipPatterns
      .filter(pattern => !pattern.includes('<node_internals>'))
      .map(pattern => pathUtils.forceForwardSlashes(pattern))
      .map(urlUtils.lowerCaseInsensitivePath);

    if (nonNodeInternalGlobs.length > 0) {
      this._nonNodeInternalGlobs = nonNodeInternalGlobs;
    }
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

  private _testSkipNonNodeInternal(testString: string): boolean {
    if (this._nonNodeInternalGlobs) {
      return (
        micromatch(
          [urlUtils.lowerCaseInsensitivePath(pathUtils.forceForwardSlashes(testString))],
          this._nonNodeInternalGlobs,
          { dot: true },
        ).length > 0
      );
    }
    return false;
  }

  private _isNodeInternal(url: string, nodeInternals: ReadonlySet<string> | undefined): boolean {
    if (url.startsWith(node15InternalsPrefix)) {
      return true;
    }

    return nodeInternals?.has(url) || /^internal\/.+\.js$/.test(url);
  }

  private async _updateBlackboxedUrls(urlsToBlackbox: string[]): Promise<void> {
    const blackboxPatterns = urlsToBlackbox
      .map(url => escapeRegexSpecialChars(url))
      .map(url => `^${url}$`);
    await this.cdp.Debugger.setBlackboxPatterns({ patterns: blackboxPatterns });
  }

  private _updateGeneratedSkippedSources(): Promise<void> {
    const urlsToSkip: string[] = [];
    for (const [url, isSkipped] of this._isUrlSkipped.entries()) {
      if (isSkipped) {
        urlsToSkip.push(url);
      }
    }
    return this._updateBlackboxedUrls(urlsToSkip);
  }

  private _normalizeUrl(url: string): string {
    return pathUtils.forceForwardSlashes(url.toLowerCase());
  }

  public isScriptSkipped(url: string): boolean {
    const norm = this._normalizeUrl(url);
    return this._isUrlSkipped.get(norm) === true || this._isAuthoredUrlSkipped.get(norm) === true;
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
    const nodeInternals = this._allNodeInternals?.settledValue;
    if (this._allNodeInternals && !nodeInternals) {
      this._allNodeInternals.promise.then(v => this._initializeSkippingValueForSource(source, v));
    } else {
      this._initializeSkippingValueForSource(source, nodeInternals);
    }
  }

  private _initializeSkippingValueForSource(
    source: Source,
    nodeInternals: ReadonlySet<string> | undefined,
    scriptIds = source.scriptIds(),
  ): boolean {
    const map = source instanceof SourceFromMap ? this._isAuthoredUrlSkipped : this._isUrlSkipped;
    const url = source.url;
    if (!map.has(this._normalizeUrl(url))) {
      if (this._isNodeInternal(url, nodeInternals)) {
        map.set(url, this._testSkipNodeInternal(url));
      } else if (source.absolutePath) {
        map.set(url, this._testSkipNonNodeInternal(source.absolutePath));
      } else {
        map.set(url, this._testSkipNonNodeInternal(url));
      }
    }

    let hasSkip = this.isScriptSkipped(url);
    if (hasSkip) {
      if (isSourceWithMap(source)) {
        // if compiled and skipped, also skip authored sources
        const authoredSources = Array.from(source.sourceMap.sourceByUrl.values());
        authoredSources.forEach(authoredSource => {
          this._isAuthoredUrlSkipped.set(authoredSource.url, true);
        });
      }
    }

    if (isSourceWithMap(source)) {
      for (const nestedSource of source.sourceMap.sourceByUrl.values()) {
        hasSkip =
          this._initializeSkippingValueForSource(nestedSource, nodeInternals, scriptIds) || hasSkip;
      }

      this._updateSourceWithSkippedSourceMappedSources(source, scriptIds);
    }

    if (hasSkip) {
      this._updateSkippedDebounce();
    }

    return hasSkip;
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
    if (source) {
      const newSkipValue = !this.isScriptSkipped(source.url);
      if (source instanceof SourceFromMap) {
        this._isAuthoredUrlSkipped.set(source.url, newSkipValue);

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
        this._isUrlSkipped.set(source.url, newSkipValue);
        if (isSourceWithMap(source)) {
          // if compiled, get authored sources
          for (const authoredSource of source.sourceMap.sourceByUrl.values()) {
            this._isAuthoredUrlSkipped.set(authoredSource.url, newSkipValue);
          }
        }
      }

      await this._updateGeneratedSkippedSources();
    }

    return {};
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
