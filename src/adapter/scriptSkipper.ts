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
  private _userSkipPatterns: ReadonlyArray<string>;
  private _nonNodeInternalRegex = '';

  // filtering node internals
  private _nodeInternalsRegex = '';
  private _allNodeInternals?: string[]; // only set by Node
  skippingNodeInternals = false;

  private _isUrlSkippedMap = new Map<string, boolean>();
  private _blackboxSenders = new Set<BlackBoxSender>();
  private _allSourceContainers = new Set<SourceContainer>();

  constructor(skipPatterns: ReadonlyArray<string>) {
    this._userSkipPatterns = skipPatterns;
    this._preprocessNodeInternals();
    this._setRegexForNonNodeInternals();
  }

  private _preprocessNodeInternals(): void {
    const nodeInternalRegex = /^<node_internals>[\/\\](.*)$/;

    const nodeInternalPatterns = this._userSkipPatterns!.filter(pattern =>
      pattern.includes('<node_internals>'),
    ).map(nodeInternal => {
      nodeInternal = nodeInternal.trim();
      return nodeInternalRegex.exec(nodeInternal)![1];
    });

    this._nodeInternalsRegex = this._createRegexString(nodeInternalPatterns);
    if (nodeInternalPatterns.length > 0) {
      this.skippingNodeInternals = true;
    }
  }

  private _setRegexForNonNodeInternals(): void {
    const nonNodeInternalGlobs = this._userSkipPatterns.filter(
      pattern => !pattern.includes('<node_internals>'),
    );
    this._nonNodeInternalRegex += this._createRegexString(nonNodeInternalGlobs);
  }

  private _createRegexString(patterns: string[]): string {
    if (patterns.length === 0) return '.^';
    return patterns.map(pattern => utils.pathGlobToBlackboxedRegex(pattern)).join('|');
  }

  private _testRegex(regexPattern: string, strToTest: string): boolean {
    const regExp = new RegExp(regexPattern);
    return regExp.test(strToTest);
  }

  private _updateBlackboxedUrls(urlsToBlackbox: string[]) {
    const blackboxPatterns = urlsToBlackbox.map(url => '^' + url + '$');
    this._sendBlackboxPatterns(blackboxPatterns);
  }

  private _sendBlackboxPatterns(patterns: string[]) {
    for (const blackboxSender of this._blackboxSenders) {
      blackboxSender.sendPatterns(patterns);
    }
  }

  public registerNewBlackBoxSender(target: ITarget, debuggerAPI: cdp.DebuggerApi) {
    const sender = new BlackBoxSender(debuggerAPI);
    if (!this._blackboxSenders.has(sender)) {
      this._blackboxSenders.add(sender);
    }
  }

  private _updateSourceContainers(affectedUrls: string[], updatedSkipValue: boolean) {
    for (const container of this._allSourceContainers) {
      for (const url of affectedUrls) {
        const source = container.sourceByUrl(url);
        if (source) {
          source._blackboxed = updatedSkipValue;
        }
      }
    }
  }

  private _setUrlToSkip(url: string, skipValue: boolean): void {
    this._isUrlSkippedMap.set(pathUtils.forceForwardSlashes(url), skipValue);
  }

  public setSkippingValueForScripts(urls: string[], skipValue: boolean): void {
    urls.forEach(url => {
      this._setUrlToSkip(url, skipValue);
    });

    const urlsToSkip: string[] = [];
    for (const entry of this._isUrlSkippedMap.entries()) {
      if (entry[1]) {
        urlsToSkip.push(entry[0]);
      }
    }
    this._updateBlackboxedUrls(urlsToSkip);
    this._updateSourceContainers(urls, skipValue);
  }

  public isScriptSkipped(url: string): boolean {
    return this._isUrlSkippedMap.get(pathUtils.forceForwardSlashes(url)) === true;
  }

  public initializeNodeInternals(nodeInternalsNames: string[]): void {
    this._allNodeInternals = nodeInternalsNames.map(name => name + '.js');
  }

  private _isNodeInternal(url: string): boolean {
    return (
      (this._allNodeInternals && this._allNodeInternals.includes(url)) ||
      this._testRegex('^internal/.+\\.js$', url)
    );
  }

  public async updateSkippingValueForScript(source: Source) {
    const url = source.url();
    if (!this._isUrlSkippedMap.has(pathUtils.forceForwardSlashes(url))) {
      // applying sourcemappathoverrides results in incorrect absolute paths
      // for some sources that don't map to disk (e.g. node_internals), so here
      // we're checking for whether a file actually corresponds to a file on disk
      const pathOnDisk = await source.existingAbsolutePath();
      if (pathOnDisk) {
        // file maps to file on disk
        this._setUrlToSkip(url, this._testRegex(this._nonNodeInternalRegex, pathOnDisk));
      } else {
        if (this._isNodeInternal(url)) {
          this._setUrlToSkip(url, this._testRegex(this._nodeInternalsRegex, url));
        } else {
          this._setUrlToSkip(url, this._testRegex(this._nonNodeInternalRegex, url));
        }
      }
      if (this.isScriptSkipped(url)) this._updateBlackboxedUrls([url]);
    }
  }

  public async initNewTarget(
    target: ITarget,
    runtimeAPI: cdp.RuntimeApi,
    debuggerAPI: cdp.DebuggerApi,
  ): Promise<void> {
    if (target.type() === 'node' && this.skippingNodeInternals && !this._allNodeInternals) {
      const evalResult = await runtimeAPI.evaluate({
        expression: "require('module').builtinModules",
        returnByValue: true,
        includeCommandLineAPI: true,
      });
      if (evalResult && !evalResult.exceptionDetails) {
        this.initializeNodeInternals(evalResult.result.value);
      }
    }

    this.registerNewBlackBoxSender(target, debuggerAPI);
  }

  public addNewSourceContainer(sourceContainer: SourceContainer) {
    if (!this._allSourceContainers.has(sourceContainer)) {
      this._allSourceContainers.add(sourceContainer);
    }
  }

  public async toggleSkippingFile(
    params: Dap.ToggleSkipFileStatusParams,
    sourceContainer: SourceContainer,
  ): Promise<Dap.ToggleSkipFileStatusResult> {
    let source: Source | undefined;
    if (params.sourceReference) {
      source = sourceContainer.sourceByReference(params.sourceReference);
    } else if (params.resource) {
      if (urlUtils.isAbsolute(params.resource)) {
        const url = urlUtils.absolutePathToFileUrl(params.resource);
        if (url) source = sourceContainer.sourceByUrl(url);
      } else {
        source = sourceContainer.sourceByUrl(params.resource);
      }
    }

    if (!source) {
      return Error;
    }

    const newSkipValue = !source._blackboxed;
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

    this.setSkippingValueForScripts(urlsToSkip, newSkipValue);
    return {};
  }
}
