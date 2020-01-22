/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import cdp from '../cdp/api';
import Dap from '../dap/api';
import * as utils from '../common/sourceUtils';
import { ITarget } from '../targets/targets';
import { SourceContainer, Source } from './sources';
import * as urlUtils from '../common/urlUtils';
import * as pathUtils from '../common/pathUtils';
import { debounce } from '../common/objUtils';
import { MapUsingProjection } from '../common/datastructure/mapUsingProjection';

export class BlackBoxSender {
  private _blackboxSender: (
    params: cdp.Debugger.SetBlackboxPatternsParams,
  ) => Promise<cdp.Debugger.SetBlackboxPatternsResult | undefined>;

  public sendPatterns(blackboxPatterns: string[]) {
    this._blackboxSender({ patterns: blackboxPatterns });
  }

  constructor(debuggerAPI: cdp.DebuggerApi) {
    this._blackboxSender = debuggerAPI.setBlackboxPatterns.bind(debuggerAPI);
  }
}

export class ScriptSkipper {
  private _nonNodeInternalRegex: RegExp | null = null;

  // filtering node internals
  private _nodeInternalsRegex: RegExp | null = null;
  private _allNodeInternals?: string[]; // only set by Node

  private _isUrlSkippedMap: Map<string, boolean>;
  private _blackboxSenders = new Set<BlackBoxSender>();

  private _newScriptDebouncer: () => void;
  private _unprocessedSources: Source[] = [];

  constructor(skipPatterns: ReadonlyArray<string>) {
    this._isUrlSkippedMap = new MapUsingProjection<string, boolean>(key => this._normalizeUrl(key));

    this._preprocessNodeInternals(skipPatterns);
    this._setRegexForNonNodeInternals(skipPatterns);
    this._newScriptDebouncer = debounce(400, () => this._updateSkippingValueForAllScripts());
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
    return patterns.map(pattern => utils.pathGlobToBlackboxedRegex(pattern)).join('|');
  }

  private _testRegex(regex: RegExp, strToTest: string): boolean {
    return regex.test(strToTest);
  }

  private _testSkipNodeInternal(testString: string): boolean {
    if (this._nodeInternalsRegex) {
      return this._testRegex(this._nodeInternalsRegex, testString);
    }
    return false;
  }

  private _testSkipNonNodeInternal(testString: string): boolean {
    if (this._nonNodeInternalRegex) {
      return this._testRegex(this._nonNodeInternalRegex, testString);
    }
    return false;
  }

  private _isNodeInternal(url: string): boolean {
    return (
      (this._allNodeInternals && this._allNodeInternals.includes(url)) ||
      this._testRegex(/^internal\/.+\.js$/, url)
    );
  }

  private _updateBlackboxedUrls(urlsToBlackbox: string[]) {
    const blackboxPatterns = urlsToBlackbox.map(url => '^' + url + '$');
    this._sendBlackboxPatterns(blackboxPatterns);
  }

  private _updateAllScriptsToBeSkipped(): void {
    const urlsToSkip: string[] = [];
    for (const [url, isSkipped] of this._isUrlSkippedMap.entries()) {
      if (isSkipped) {
        urlsToSkip.push(url);
      }
    }
    this._updateBlackboxedUrls(urlsToSkip);
  }

  private _sendBlackboxPatterns(patterns: string[]) {
    for (const blackboxSender of this._blackboxSenders) {
      blackboxSender.sendPatterns(patterns);
    }
  }

  private _normalizeUrl(url: string): string {
    return pathUtils.forceForwardSlashes(url.toLowerCase());
  }

  public registerNewBlackBoxSender(debuggerAPI: cdp.DebuggerApi) {
    const sender = new BlackBoxSender(debuggerAPI);
    if (!this._blackboxSenders.has(sender)) {
      this._blackboxSenders.add(sender);
    }
  }

  private _setSkippingValueForScripts(urls: string[], skipValue: boolean): void {
    urls.forEach(url => {
      this._isUrlSkippedMap.set(url, skipValue);
    });

    this._updateAllScriptsToBeSkipped();
  }

  public isScriptSkipped(url: string): boolean {
    return this._isUrlSkippedMap.get(this._normalizeUrl(url)) === true;
  }

  private _hasScript(url: string): boolean {
    return this._isUrlSkippedMap.has(this._normalizeUrl(url));
  }

  public updateSkippingValueForScript(source: Source) {
    this._unprocessedSources.push(source);
    this._newScriptDebouncer();
  }

  private async _updateSkippingValueForAllScripts() {
    const skipStatuses = await Promise.all(
      this._unprocessedSources.map(s => this._updateSkippingValueForScript(s)),
    );

    if (skipStatuses.some(s => !!s)) {
      this._updateAllScriptsToBeSkipped();
    }

    this._unprocessedSources = [];
  }

  private async _updateSkippingValueForScript(source: Source): Promise<boolean> {
    const url = source.url();
    if (!this._isUrlSkippedMap.has(this._normalizeUrl(url))) {
      // applying sourcemappathoverrides results in incorrect absolute paths
      // for some sources that don't map to disk (e.g. node_internals), so here
      // we're checking for whether a file actually corresponds to a file on disk
      const pathOnDisk = await source.existingAbsolutePath();
      if (pathOnDisk) {
        // file maps to file on disk
        this._isUrlSkippedMap.set(url, this._testSkipNonNodeInternal(pathOnDisk));
      } else {
        if (this._isNodeInternal(url)) {
          this._isUrlSkippedMap.set(url, this._testSkipNodeInternal(url));
        } else {
          this._isUrlSkippedMap.set(url, this._testSkipNonNodeInternal(url));
        }
      }

      let correspondingSources: Source[] | null = null;
      if (source._sourceMapSourceByUrl) {
        // if compiled, get authored sources
        correspondingSources = Array.from(source._sourceMapSourceByUrl.values());
      } else if (source._compiledToSourceUrl) {
        correspondingSources = Array.from(source._compiledToSourceUrl.keys());
        // if authored, get compiled sources
      }

      if (correspondingSources) {
        const correspondingScriptIsSkipped = correspondingSources.some(correspondingSource =>
          this.isScriptSkipped(correspondingSource._url),
        );
        if (this.isScriptSkipped(source._url) || correspondingScriptIsSkipped) {
          this._isUrlSkippedMap.set(source._url, true);
          correspondingSources.forEach(correspondingSource => {
            this._isUrlSkippedMap.set(correspondingSource._url, true);
          });
        }
      }

      return this.isScriptSkipped(url);
    }

    return false;
  }

  public async initNewTarget(
    target: ITarget,
    runtimeAPI: cdp.RuntimeApi,
    debuggerAPI: cdp.DebuggerApi,
  ): Promise<void> {
    if (target.type() === 'node' && this._nodeInternalsRegex && !this._allNodeInternals) {
      const evalResult = await runtimeAPI.evaluate({
        expression: "require('module').builtinModules",
        returnByValue: true,
        includeCommandLineAPI: true,
      });
      if (evalResult && !evalResult.exceptionDetails) {
        this._allNodeInternals = (evalResult.result.value as string[]).map(name => name + '.js');
      }
    }

    this.registerNewBlackBoxSender(debuggerAPI);
  }

  public async toggleSkippingFile(
    params: Dap.ToggleSkipFileStatusParams,
    sourceContainer: SourceContainer,
  ): Promise<Dap.ToggleSkipFileStatusResult> {
    let path: string | undefined = undefined;
    if (params.resource) {
      if (urlUtils.isAbsolute(params.resource)) {
        path = params.resource;
      }
    }
    const sourceParams: Dap.Source = { path: path, sourceReference: params.sourceReference };

    const source = sourceContainer.source(sourceParams);
    if (source) {
      const urlsToSkip: string[] = [source._url];
      if (source._sourceMapSourceByUrl) {
        // if compiled, get authored sources
        for (const authoredSource of source._sourceMapSourceByUrl.values()) {
          urlsToSkip.push(authoredSource._url);
        }
      } else if (source._compiledToSourceUrl) {
        // if authored, get compiled sources
        for (const compiledSource of source._compiledToSourceUrl.keys()) {
          urlsToSkip.push(compiledSource._url);
        }
      }

      const newSkipValue = !this.isScriptSkipped(source.url());
      this._setSkippingValueForScripts(urlsToSkip, newSkipValue);
    } else {
      if (params.resource && this._hasScript(params.resource)) {
        this._isUrlSkippedMap.set(params.resource, !this.isScriptSkipped(params.resource));
      }
    }

    return {};
  }
}
