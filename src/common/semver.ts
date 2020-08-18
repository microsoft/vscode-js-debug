/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

export class Semver {
  public static parse(str: string) {
    const parts = str.split('.').map(Number);
    if (parts.length !== 3 || parts.some(isNaN)) {
      throw new SyntaxError(`Input string '${str}' is not a semver`);
    }

    return new Semver(parts[0], parts[1], parts[2]);
  }

  /**
   * Returns the lower of the two semver versions.
   */
  public static min(a: Semver, b: Semver) {
    return a.lt(b) ? a : b;
  }

  constructor(
    public readonly major: number,
    public readonly minor: number,
    public readonly patch: number,
  ) {}

  /**
   * @returns 0 if the versions are equal, >0 if this is greater than the given
   * semver, or <0 if it's less than the other semver.
   */
  public compare(other: Semver) {
    return this.major - other.major || this.minor - other.minor || this.patch - other.patch;
  }

  /**
   * @returns true if this version is after the other
   */
  public gt(other: Semver) {
    return this.compare(other) > 0;
  }

  /**
   * @returns true if this version is after or equal to the other
   */
  public gte(other: Semver) {
    return this.compare(other) >= 0;
  }

  /**
   * @returns true if this version is before the other
   */
  public lt(other: Semver) {
    return this.compare(other) < 0;
  }

  /**
   * @returns true if this version is before or equal to the other
   */
  public lte(other: Semver) {
    return this.compare(other) <= 0;
  }

  /**
   * @inheritdoc
   */
  public toString() {
    return `${this.major}.${this.minor}.${this.patch}`;
  }
}
