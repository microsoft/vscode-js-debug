// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import cdp from '../cdp/api';
import * as utils from '../common/sourceUtils';

export class ScriptSkipper {
  private _userSkipPatterns: ReadonlyArray<string>;
  private _nonNodeInternalRegex: string = '';

  // filtering node internals
  private _nodeInternalsRegex: string = '';
  private _allNodeInternals?: string[]; // for use with Node -- not set by Chrome

  private _isUrlSkippedMap = new Map<string, boolean>();

  private _blackboxedUrls: string[] = [];
  private blackboxSender?: (params: cdp.Debugger.SetBlackboxPatternsParams) => Promise<cdp.Debugger.SetBlackboxPatternsResult | undefined>;

  constructor(skipPatterns: ReadonlyArray<string>) {
    this._userSkipPatterns = skipPatterns;
    this._preprocessNodeInternals();
    this._setRegexForNonNodeInternals();
  }

  private _preprocessNodeInternals(): void {
    const nodeInternalRegex = /^<node_internals>[\/\\](.*)$/;

    const nodeInternalPatterns = this._userSkipPatterns!
      .filter(pattern => pattern.includes('<node_internals>'))
      .map(nodeInternal => {
        nodeInternal = nodeInternal.trim();
        return nodeInternalRegex.exec(nodeInternal)![1];
      });

    if (nodeInternalPatterns.length > 0) {
      this._nodeInternalsRegex = this._createRegexString(nodeInternalPatterns);
    }
  }

  private _setRegexForNonNodeInternals(): void {
    const nonNodeInternalGlobs = this._userSkipPatterns.filter(pattern => !pattern.includes('<node_internals>'));
    this._nonNodeInternalRegex = this._createRegexString(nonNodeInternalGlobs);
  }

  private _createRegexString(patterns: string[]): string {
    if (patterns.length === 0)
      return '.^';
    return patterns.map(pattern => utils.pathGlobToBlackboxedRegex(pattern)).join('|');
  }

  private _testRegex(regexPattern: string, strToTest: string): boolean {
    const regExp = new RegExp(regexPattern);
    return regExp.test(strToTest);
  }

  private _updateBlackboxedUrls(url: string) {
    if (this._isUrlSkippedMap.get(url) && this.blackboxSender) {
      this._blackboxedUrls.push(url);
      let blackboxPattern = '^' + this._createRegexString(this._blackboxedUrls) + '$';
      this.blackboxSender({patterns: [blackboxPattern]});
    }
  }

  private _isNodeInternal(url: string): boolean {
    return (this._allNodeInternals && this._allNodeInternals.includes(url)) || this._testRegex('^internal/.+\.js$', url);
  }

  public setBlackboxSender(debuggerAPI: cdp.DebuggerApi) {
    this.blackboxSender = debuggerAPI.setBlackboxPatterns.bind(debuggerAPI);
  }

  public updateSkippingForScript(localpath: string, url: string): void {
    if (!this._isUrlSkippedMap.has(url)) {
      if (localpath) { // file maps to file on disk
        this._isUrlSkippedMap.set(url, this._testRegex(this._nonNodeInternalRegex, localpath));
      }
      else {
        if (this._isNodeInternal(url)) {
          this._isUrlSkippedMap.set(url, this._testRegex(this._nodeInternalsRegex, url));
        }
        else {
          this._isUrlSkippedMap.set(url, this._testRegex(this._nonNodeInternalRegex, url));
        }
      }
      this._updateBlackboxedUrls(url);
    }
  }

  public isScriptSkipped(url: string): boolean {
    return this._isUrlSkippedMap.get(url)!;
  }

  public setAllNodeInternals(nodeInternalsNames: string[]): void {
    this._allNodeInternals = nodeInternalsNames.map(name => name + '.js');
  }

  public toggleSkipFileStatus(url: string | undefined): void {
    if (url) {
      let currentSkipValue = this._isUrlSkippedMap.get(url);
      this._isUrlSkippedMap.set(url, !currentSkipValue);
    }
  }

}