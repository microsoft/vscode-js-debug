/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
import { expect } from 'chai';
import {
  Base01Position,
  Base0Position,
  Base1Position,
  comparePositions,
  PositionRange,
} from './positions';

describe('IPosition', () => {
  describe('compare', () => {
    it('should return a negative number if the current position is before the other position', () => {
      const position = new Base0Position(1, 1);
      const other = new Base0Position(2, 2);
      expect(position.compare(other)).to.be.lessThan(0);
    });
    it('should return a positive number if the current position is after the other position', () => {
      const position = new Base0Position(2, 2);
      const other = new Base0Position(1, 1);
      expect(position.compare(other)).to.be.greaterThan(0);
    });
    it('should return 0 if the current position is equal to the other position', () => {
      const position = new Base0Position(1, 1);
      const other = new Base0Position(1, 1);
      expect(position.compare(other)).to.equal(0);
    });

    it('compares across bases', () => {
      expect(comparePositions(new Base0Position(1, 1), new Base1Position(2, 2))).to.equal(0);
      expect(comparePositions(new Base0Position(1, 1), new Base01Position(2, 1))).to.equal(0);
      expect(comparePositions(new Base1Position(2, 2), new Base01Position(2, 1))).to.equal(0);
    });
  });

  it('range.contains', () => {
    const range = new PositionRange(new Base0Position(1, 0), new Base1Position(5, 5));

    expect(range.contains(new Base0Position(1, 0))).to.be.true;
    expect(range.contains(new Base0Position(2, 0))).to.be.true;
    expect(range.contains(new Base0Position(4, 0))).to.be.true;
    expect(range.contains(new Base0Position(5.5, 0))).to.be.false;
    expect(range.contains(new Base0Position(4, 6))).to.be.false;

    expect(range.contains(new Base1Position(4.5, 0))).to.be.true;
  });
});
