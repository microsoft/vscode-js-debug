/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import cdp, { Cdp } from '../cdp/api';
import Dap from '../dap/api';
import * as utils from '../common/sourceUtils';
import { ITarget } from '../targets/targets';
import { SourceContainer, Source } from './sources';
import * as urlUtils from '../common/urlUtils';
import * as pathUtils from '../common/pathUtils';
import { debounce } from '../common/objUtils';
import { MapUsingProjection } from '../common/datastructure/mapUsingProjection';

export class BlackBoxSender {
  public sendPatterns(blackboxPatterns: string[]) {
    this.debuggerAPI.setBlackboxPatterns({ patterns: blackboxPatterns });
  }

  public sendRanges(params: cdp.Debugger.SetBlackboxedRangesParams): void {
    this.debuggerAPI.setBlackboxedRanges(params);
  }

  constructor(public targetId: string, private debuggerAPI: cdp.DebuggerApi) {
  }
}

export class ScriptSkipper {
  // TODO yikes
  public sourceContainerToTarget = new Map<SourceContainer, string>();

  private _nonNodeInternalRegex: RegExp | null = null;

  // filtering node internals
  private _nodeInternalsRegex: RegExp | null = null;
  private _allNodeInternals?: string[]; // only set by Node

  private _isUrlSkipped: Map<string, boolean>;
  private _isAuthoredUrlSkipped: Map<string, boolean>;

  private _blackboxSenders = new Set<BlackBoxSender>();

  private _newScriptDebouncer: () => void;
  private _unprocessedSources: [Source, SourceContainer][] = [];

  constructor(skipPatterns: ReadonlyArray<string>) {
    this._isUrlSkipped = new MapUsingProjection<string, boolean>(key => this._normalizeUrl(key));
    this._isAuthoredUrlSkipped = new MapUsingProjection<string, boolean>(key => this._normalizeUrl(key));

    this._preprocessNodeInternals(skipPatterns);
    this._setRegexForNonNodeInternals(skipPatterns);
    this._newScriptDebouncer = debounce(100, () => this._initializeSkippingValueForNewSources());
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

  private _updateBlackboxedUrls(urlsToBlackbox: string[]) {
    // TODO safely escape url for regex
    const blackboxPatterns = urlsToBlackbox.map(url => '^' + url + '$');
    this._sendBlackboxPatterns(blackboxPatterns);
  }

  private _updateGeneratedSkippedSources(): void {
    const urlsToSkip: string[] = [];
    for (const [url, isSkipped] of this._isUrlSkipped.entries()) {
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

  public registerNewBlackBoxSender(id: string, debuggerAPI: cdp.DebuggerApi) {
    const sender = new BlackBoxSender(id, debuggerAPI);
    if (!this._blackboxSenders.has(sender)) {
      this._blackboxSenders.add(sender);
    }
  }

  private _setSkippingValueForScripts(urls: string[], skipValue: boolean): void {
    urls.forEach(url => {
      this._isUrlSkipped.set(url, skipValue);
    });

    this._updateGeneratedSkippedSources();
  }

  public isScriptSkipped(url: string): boolean {
    return this._isUrlSkipped.get(this._normalizeUrl(url)) === true ||
      this._isAuthoredUrlSkipped.get(this._normalizeUrl(url)) === true;
  }

  private _hasScript(url: string): boolean {
    return this._isUrlSkipped.has(this._normalizeUrl(url));
  }

  private async _initializeSourceMappedSources(source: Source, sourceContainer: SourceContainer): Promise<void> {
    const targetId = this.sourceContainerToTarget.get(sourceContainer);

    // source._compiledToSourceUrl?.forEach((url, compiledSource) => {
    //   this._blackboxSenders.forEach(sender => {
    //     if (targetId === sender.targetId) {
    //       sender.sendRanges({ scriptId: compiledSource.scriptId!, positions: [{ columnNumber: 0, lineNumber: 89 }, {columnNumber: 0, lineNumber: 103}] });
    //     }
    //   });
    // });

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
        const locations = sourceContainer.currentSiblingUiLocations({ source: authoredSource, lineNumber: 1, columnNumber: 1 }, source);
        if (locations[0]) {
          skipRanges.push({
            lineNumber: locations[0].lineNumber - 1,
            columnNumber: locations[0].columnNumber - 1
          });
          inSkipRange = !inSkipRange;
        } else {
          // log something
        }
      }
    });

    this._blackboxSenders.forEach(sender => {
      if (targetId === sender.targetId) {
        sender.sendRanges({ scriptId: source.scriptId!, positions: skipRanges });
      }
    });
  }

//   public async resolveSkipFiles(script: Crdp.Debugger.ScriptParsedEvent, mappedUrl: string, sources: string[], toggling?: boolean): Promise<void> {
//     if (sources && sources.length) {
//         const parentIsSkipped = this.shouldSkipSource(script.url);
//         const libPositions: Crdp.Debugger.ScriptPosition[] = [];

//         // Figure out skip/noskip transitions within script
//         let inLibRange = parentIsSkipped;
//         for (let s of sources) {
//             let isSkippedFile = this.shouldSkipSource(s);
//             if (typeof isSkippedFile !== 'boolean') {
//                 // Inherit the parent's status
//                 isSkippedFile = parentIsSkipped;
//             }

//             this._skipFileStatuses.set(s, isSkippedFile);

//             if ((isSkippedFile && !inLibRange) || (!isSkippedFile && inLibRange)) {
//                 const details = await this._transformers.sourceMapTransformer.allSourcePathDetails(mappedUrl);
//                 const detail = details.find(d => d.inferredPath === s);
//                 if (detail.startPosition) {
//                     libPositions.push({
//                         lineNumber: detail.startPosition.line,
//                         columnNumber: detail.startPosition.column
//                     });
//                 }

//                 inLibRange = !inLibRange;
//             }
//         }

//         // If there's any change from the default, set proper blackboxed ranges
//         if (libPositions.length || toggling) {
//             if (parentIsSkipped) {
//                 libPositions.splice(0, 0, { lineNumber: 0, columnNumber: 0});
//             }

//             if (libPositions[0].lineNumber !== 0 || libPositions[0].columnNumber !== 0) {
//                 // The list of blackboxed ranges must start with 0,0 for some reason.
//                 // https://github.com/Microsoft/vscode-chrome-debug/issues/667
//                 libPositions[0] = {
//                     lineNumber: 0,
//                     columnNumber: 0
//                 };
//             }

//             await this.chrome.Debugger.setBlackboxedRanges({
//                 scriptId: script.scriptId,
//                 positions: []
//             }).catch(() => this.warnNoSkipFiles());

//             if (libPositions.length) {
//                 this.chrome.Debugger.setBlackboxedRanges({
//                     scriptId: script.scriptId,
//                     positions: libPositions
//                 }).catch(() => this.warnNoSkipFiles());
//             }
//         }
//     } else {
//         const status = await this.getSkipStatus(mappedUrl);
//         const skippedByPattern = this.matchesSkipFilesPatterns(mappedUrl);
//         if (typeof status === 'boolean' && status !== skippedByPattern) {
//             const positions = status ? [{ lineNumber: 0, columnNumber: 0 }] : [];
//             this.chrome.Debugger.setBlackboxedRanges({
//                 scriptId: script.scriptId,
//                 positions
//             }).catch(() => this.warnNoSkipFiles());
//         }
//     }
// }

  public initializeSkippingValueForSource(source: Source, sourceContainer: SourceContainer) {
    this._unprocessedSources.push([source, sourceContainer]);
    this._newScriptDebouncer();
  }

  private async _initializeSkippingValueForNewSources() {
    const skipStatuses = await Promise.all(
      this._unprocessedSources.map(([source, sourceContainer]) => this._initializeSkippingValueForSource(source, sourceContainer)),
    );

    if (skipStatuses.some(s => !!s)) {
      this._updateGeneratedSkippedSources();
    }

    this._unprocessedSources = [];
  }

  private async _initializeSkippingValueForSource(source: Source, sourceContainer: SourceContainer): Promise<boolean> {
    const map = isAuthored(source) ? this._isAuthoredUrlSkipped : this._isUrlSkipped;

    const url = source.url();
    if (!map.has(this._normalizeUrl(url))) { // TODO is this check correct (?)
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
        await Promise.all(sourceMapSources.map(s => this._initializeSkippingValueForSource(s, sourceContainer)));
        this._initializeSourceMappedSources(source, sourceContainer);
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

    this.registerNewBlackBoxSender(target.id(), debuggerAPI);
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
        this._isUrlSkipped.set(params.resource, !this.isScriptSkipped(params.resource));
      }
    }

    return {};
  }
}

function isAuthored(source: Source) {
  return source._compiledToSourceUrl;
}
