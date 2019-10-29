// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import cdp from '../cdp/api';
import * as utils from '../common/sourceUtils';

export class ScriptSkipper {
  private _userSkipPatterns: string[];
  private _nonNodeInternalRegex: string = "";

  // filtering node internals
  private _nodeInternalsRegex: string = "";
  skipAllNodeInternals: boolean = false;

  private _isUrlSkippedMap = new Map<string, boolean>();

  private _blackboxedUrls: string[] = [];
  private blackboxSender?: (params: cdp.Debugger.SetBlackboxPatternsParams) => Promise<cdp.Debugger.SetBlackboxPatternsResult | undefined>;

  constructor(skipPatterns: string[]) {
    this._userSkipPatterns = skipPatterns;
    this._preprocessNodeInternals();
    this._setRegexForNonNodeInternals();
  }

  private _preprocessNodeInternals(): void {
    const nodeInternalRegex = new RegExp("^<node_internals>[\/|\\\\](.*)$");
    const skipAllNodeInternalsRegex = new RegExp("^<node_internals>[\/|\\\\]\\*\\*[\/|\\\\]\\*.js");

    const nodeInternalPatterns = this._userSkipPatterns!
      .filter(pattern => pattern.includes("<node_internals>"))
      .map(nodeInternal => {
        nodeInternal = nodeInternal.trim();
        if (skipAllNodeInternalsRegex.test(nodeInternal)) { // check if all node internals are skipped
          this.skipAllNodeInternals = true;
        }
        return utils.pathGlobToBlackboxedRegex(nodeInternalRegex.exec(nodeInternal)![1]);
      });

    if (!this.skipAllNodeInternals && nodeInternalPatterns.length > 0) {
      this._nodeInternalsRegex = this._createRegexString(nodeInternalPatterns);
    }
  }

  private _setRegexForNonNodeInternals(): void {
    var nonNodeInternalGlobs = this._userSkipPatterns
      .filter(pattern => !pattern.includes("<node_internals>"))
      .map(glob => {
        return utils.pathGlobToBlackboxedRegex(glob);
      });

    this._nonNodeInternalRegex += this._createRegexString(nonNodeInternalGlobs);
  }

  private _createRegexString(patterns: string[]): string {
    if (patterns.length == 0)
      return ".^";
    return patterns.map(pattern => pattern.replace('.', '\.')).join('|');
  }

  private _testRegex(regexPattern: string, strToTest: string): boolean {
    let regExp = new RegExp(regexPattern);
    return regExp.test(strToTest);
  }

  private _updateBlackboxedUrls(url: string) {
    if (this._isUrlSkippedMap.get(url) && this.blackboxSender) {
      this._blackboxedUrls.push(url);
      let blackboxPattern = "^" + this._blackboxedUrls.join("|") + "$";
      this.blackboxSender({patterns: [blackboxPattern]});
    }
  }

  public setBlackboxSender(debuggerAPI: cdp.DebuggerApi) {
    this.blackboxSender = debuggerAPI.setBlackboxPatterns.bind(debuggerAPI);
  }

  public updateSkippingForScript(localpath, url): void {
    if (!this._isUrlSkippedMap.has(url)) {
      if (localpath) {
        this._isUrlSkippedMap.set(url, this._testRegex(this._nonNodeInternalRegex, localpath));
      }
      else {
        this._isUrlSkippedMap.set(url, this._testRegex(this._nodeInternalsRegex, url));
      }

      this._updateBlackboxedUrls(url);
    }
  }

  public isScriptSkipped(url: string): boolean {
    return this._isUrlSkippedMap.get(url)!;
  }

  public setAllNodeInternalsToSkip(nodeInternalsNames: string[]): void {
    let fullLibNames = nodeInternalsNames.map(name => name + ".js");
    fullLibNames.push('^internal/.+\.js|');
    this._nodeInternalsRegex = this._createRegexString(fullLibNames);
  }

}