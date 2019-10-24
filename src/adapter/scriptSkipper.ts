import cdp from '../cdp/api';

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
    let nodeInternalRegex = new RegExp("^<node_internals>\/(.*)$");
    let nodeInternalPatterns = this._userSkipPatterns!.filter(pattern => pattern.includes("<node_internals>")).map( nodeInternal => {
      return nodeInternalRegex.exec(nodeInternal)![1];
    });
    if (nodeInternalPatterns.length > 0) { // set variables to use to filter node internals when in module
      if (nodeInternalPatterns.includes("**/*.js"))
        this.skipAllNodeInternals = true; // this value is checked later at a later processing point
      else
        this._nodeInternalsRegex = this._createRegexString(nodeInternalPatterns);
    }
  }

  private _setRegexForNonNodeInternals(): void {
    var nonNodeInternalGlobs = this._userSkipPatterns.filter(pattern => !pattern.includes("<node_internals>"));
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