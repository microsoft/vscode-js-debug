export class ScriptSkipper {
  private _skipPatterns: string[];

  constructor(skipPatterns: string[]) {
    this._skipPatterns = skipPatterns;
  }

}