/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { Cdp } from '../cdp/api';
import { MapUsingProjection } from '../common/datastructure/mapUsingProjection';
import { EventEmitter } from '../common/events';
import { debounce } from '../common/objUtils';
import * as pathUtils from '../common/pathUtils';
import * as utils from '../common/sourceUtils';
import * as urlUtils from '../common/urlUtils';
import Dap from '../dap/api';
import { ITarget } from '../targets/targets';
import { Source, SourceContainer } from './sources';
import { escapeRegexSpecialChars } from '../common/stringUtils';
import { logger } from '../common/logging/logger';
import { LogTag } from '../common/logging';

interface ISharedSkipToggleEvent {
  rootTargetId: string;
  targetId: string;
  params: Dap.ToggleSkipFileStatusParams;
}

export class ScriptSkipper {
  private static sharedSkipsEmitter = new EventEmitter<ISharedSkipToggleEvent>();

  private _nonNodeInternalRegex: RegExp | null = null;

  // filtering node internals
  private _nodeInternalsRegex: RegExp | null = null;
  private _allNodeInternals?: string[]; // only set by Node

  private _isUrlSkipped: Map<string, boolean>;
  private _isAuthoredUrlSkipped: Map<string, boolean>;

  private _newScriptDebouncer: () => void;
  private _unprocessedSources: [Source, Cdp.Runtime.ScriptId][] = [];

  private _sourceContainer: SourceContainer | undefined;

  private _targetId: string;
  private _rootTargetId: string;

  constructor(skipPatterns: ReadonlyArray<string>, private readonly cdp: Cdp.Api, target: ITarget) {
    this._targetId = target.id();
    this._rootTargetId = getRootTarget(target).id();
    this._isUrlSkipped = new MapUsingProjection<string, boolean>(key => this._normalizeUrl(key));
    this._isAuthoredUrlSkipped = new MapUsingProjection<string, boolean>(key =>
      this._normalizeUrl(key),
    );

    this._preprocessNodeInternals(skipPatterns);
    this._setRegexForNonNodeInternals(skipPatterns);
    this._initNodeInternals(target); // Purposely don't wait, no need to slow things down
    this._newScriptDebouncer = debounce(100, () => this._initializeSkippingValueForNewSources());

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
      this._nodeInternalsRegex = new RegExp(this._createRegexString(nodeInternalPatterns));
    }
  }

  private _setRegexForNonNodeInternals(userSkipPatterns: ReadonlyArray<string>): void {
    const nonNodeInternalGlobs = userSkipPatterns.filter(
      pattern => !pattern.includes('<node_internals>'),
    );

    if (nonNodeInternalGlobs.length > 0) {
      this._nonNodeInternalRegex = new RegExp(this._createRegexString(nonNodeInternalGlobs));
    }
  }

  private _createRegexString(patterns: string[]): string {
    // TODO this should use node-glob directly
    return patterns.map(pattern => utils.pathGlobToBlackboxedRegex(pattern)).join('|');
  }

  private _testSkipNodeInternal(testString: string): boolean {
    if (this._nodeInternalsRegex) {
      return this._nodeInternalsRegex.test(testString);
    }
    return false;
  }

  private _testSkipNonNodeInternal(testString: string): boolean {
    if (this._nonNodeInternalRegex) {
      return this._nonNodeInternalRegex.test(testString);
    }
    return false;
  }

  private _isNodeInternal(url: string): boolean {
    return (
      (this._allNodeInternals && this._allNodeInternals.includes(url)) ||
      /^internal\/.+\.js$/.test(url)
    );
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
    return (
      this._isUrlSkipped.get(this._normalizeUrl(url)) === true ||
      this._isAuthoredUrlSkipped.get(this._normalizeUrl(url)) === true
    );
  }

  private async _updateSourceWithSkippedSourceMappedSources(
    source: Source,
    ...scriptIds: Cdp.Runtime.ScriptId[]
  ): Promise<void> {
    // Order "should" be correct
    const parentIsSkipped = this.isScriptSkipped(source.url());
    const skipRanges: Cdp.Debugger.ScriptPosition[] = [];
    let inSkipRange = parentIsSkipped;
    Array.from(source._sourceMapSourceByUrl!.values()).forEach(authoredSource => {
      let isSkippedSource = this.isScriptSkipped(authoredSource.url());
      if (typeof isSkippedSource === 'undefined') {
        // If not toggled or specified in launch config, inherit the parent's status
        isSkippedSource = parentIsSkipped;
      }

      if (isSkippedSource !== inSkipRange) {
        const locations = this._sourceContainer!.currentSiblingUiLocations(
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
          logger.error(
            LogTag.Internal,
            'Could not map script beginning for ' + authoredSource._name,
          );
        }
      }
    });

    await Promise.all(
      scriptIds.map(scriptId =>
        this.cdp.Debugger.setBlackboxedRanges({ scriptId, positions: skipRanges }),
      ),
    );
  }

  public initializeSkippingValueForSource(source: Source, scriptId: Cdp.Runtime.ScriptId) {
    this._unprocessedSources.push([source, scriptId]);
    this._newScriptDebouncer();
  }

  private async _initializeSkippingValueForNewSources() {
    const skipStatuses = await Promise.all(
      this._unprocessedSources.map(([source, scriptId]) =>
        this._initializeSkippingValueForSource(source, scriptId),
      ),
    );

    if (skipStatuses.some(s => !!s)) {
      this._updateGeneratedSkippedSources();
    }

    this._unprocessedSources = [];
  }

  private async _initializeSkippingValueForSource(
    source: Source,
    scriptId: Cdp.Runtime.ScriptId,
  ): Promise<boolean> {
    const map = isAuthored(source) ? this._isAuthoredUrlSkipped : this._isUrlSkipped;

    const url = source.url();
    if (!map.has(this._normalizeUrl(url))) {
      const pathOnDisk = await source.existingAbsolutePath();
      if (pathOnDisk) {
        // file maps to file on disk
        map.set(url, this._testSkipNonNodeInternal(pathOnDisk));
      } else {
        if (this._isNodeInternal(url)) {
          map.set(url, this._testSkipNodeInternal(url));
        } else {
          map.set(url, this._testSkipNonNodeInternal(url));
        }
      }

      if (this.isScriptSkipped(source._url)) {
        if (source._sourceMapSourceByUrl) {
          // if compiled and skipped, also skip authored sources
          const authoredSources = Array.from(source._sourceMapSourceByUrl.values());
          authoredSources.forEach(authoredSource => {
            this._isAuthoredUrlSkipped.set(authoredSource._url, true);
          });
        }
      }

      if (source._sourceMapSourceByUrl) {
        const sourceMapSources = Array.from(source._sourceMapSourceByUrl.values());
        await Promise.all(
          sourceMapSources.map(s => this._initializeSkippingValueForSource(s, scriptId)),
        );
        this._updateSourceWithSkippedSourceMappedSources(source, scriptId);
      }

      return this.isScriptSkipped(url);
    }

    return false;
  }

  private async _initNodeInternals(target: ITarget): Promise<void> {
    if (target.type() === 'node' && this._nodeInternalsRegex && !this._allNodeInternals) {
      const evalResult = await this.cdp.Runtime.evaluate({
        expression: "require('module').builtinModules",
        returnByValue: true,
        includeCommandLineAPI: true,
      });
      if (evalResult && !evalResult.exceptionDetails) {
        this._allNodeInternals = (evalResult.result.value as string[]).map(name => name + '.js');
      }
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

    const source = this._sourceContainer!.source(sourceParams);
    if (source) {
      const newSkipValue = !this.isScriptSkipped(source.url());
      if (isAuthored(source)) {
        this._isAuthoredUrlSkipped.set(source.url(), newSkipValue);

        // Changed the skip value for an authored source, update it for all its compiled sources
        const compiledSources = Array.from(source._compiledToSourceUrl!.keys());
        await Promise.all(
          compiledSources.map(compiledSource =>
            this._updateSourceWithSkippedSourceMappedSources(
              compiledSource,
              ...compiledSource.scriptIds(),
            ),
          ),
        );
      } else {
        this._isUrlSkipped.set(source.url(), newSkipValue);
        if (source._sourceMapSourceByUrl) {
          // if compiled, get authored sources
          for (const authoredSource of source._sourceMapSourceByUrl.values()) {
            this._isAuthoredUrlSkipped.set(authoredSource.url(), newSkipValue);
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
    const result = this._toggleSkippingFile(params);
    ScriptSkipper.sharedSkipsEmitter.fire({
      params,
      rootTargetId: this._rootTargetId,
      targetId: this._targetId,
    });
    return result;
  }
}

function isAuthored(source: Source) {
  return source._compiledToSourceUrl;
}

function getRootTarget(target: ITarget): ITarget {
  const parent = target.parent();
  if (parent) {
    return getRootTarget(parent);
  } else {
    return target;
  }
}
