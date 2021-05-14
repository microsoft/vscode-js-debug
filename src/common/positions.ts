/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

/**
 * Defines a position which gives accessors to various projections. We use
 * many different kinds of bases for different consumers, this is intended
 * to elimate off-by-1 errors.
 */
export interface IPosition {
  base0: Base0Position;
  base1: Base1Position;
  base01: Base01Position;
  /**
   * Compares the position and returns the sort order, <0 if `this` is
   * before `other`, >0 if it's after, 0 if it's equal.
   */
  compare(other: IPosition): number;
}

export const comparePositions = (a: IPosition, b: IPosition) => {
  if (a instanceof Base0Position) {
    return a.compare(b.base0);
  } else if (a instanceof Base01Position) {
    return b.compare(b.base01);
  } else if (a instanceof Base1Position) {
    return b.compare(b.base1);
  } else {
    throw new Error(`Invalid position ${a}`);
  }
};

/**
 * A position that starts a line 0 and column 0 (used by CDP).
 */
export class Base0Position implements IPosition {
  declare readonly __isBase0: undefined;

  constructor(public readonly lineNumber: number, public readonly columnNumber: number) {}

  public get base0() {
    return this;
  }

  public get base1() {
    return new Base1Position(this.lineNumber + 1, this.columnNumber + 1);
  }

  public get base01() {
    return new Base01Position(this.lineNumber, this.columnNumber + 1);
  }

  public compare(other: Base0Position) {
    return this.lineNumber - other.lineNumber || this.columnNumber - other.columnNumber || 0;
  }
}

/**
 * A position that starts a line 1 and column 1 (used by DAP).
 */
export class Base1Position implements IPosition {
  declare readonly __isBase1: undefined;

  constructor(public readonly lineNumber: number, public readonly columnNumber: number) {}

  public get base0() {
    return new Base0Position(this.lineNumber - 1, this.columnNumber - 1);
  }

  public get base1() {
    return this;
  }

  public get base01() {
    return new Base01Position(this.lineNumber - 1, this.columnNumber);
  }

  public compare(other: Base1Position) {
    return this.lineNumber - other.lineNumber || this.columnNumber - other.columnNumber || 0;
  }
}

/**
 * A position that starts a line 0 and column 1 (used by sourcemaps).
 */
export class Base01Position implements IPosition {
  declare readonly __isBase01: undefined;

  constructor(public readonly lineNumber: number, public readonly columnNumber: number) {}

  public get base0() {
    return new Base0Position(this.lineNumber - 1, this.columnNumber);
  }

  public get base1() {
    return new Base1Position(this.lineNumber, this.columnNumber + 1);
  }

  public get base01() {
    return this;
  }

  public compare(other: Base01Position) {
    return this.lineNumber - other.lineNumber || this.columnNumber - other.columnNumber || 0;
  }
}
