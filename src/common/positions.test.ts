/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { expect } from 'chai';
import { Base0Position, Range } from './positions';

describe('Range', () => {
  describe('simplify', () => {
    it('should merge overlapping ranges', () => {
      const range1 = new Range(new Base0Position(0, 0), new Base0Position(0, 5));
      const range2 = new Range(new Base0Position(0, 3), new Base0Position(0, 8));
      const range3 = new Range(new Base0Position(0, 10), new Base0Position(0, 15));
      const range4 = new Range(new Base0Position(0, 12), new Base0Position(0, 20));
      const range5 = new Range(new Base0Position(0, 25), new Base0Position(0, 30));
      const range6 = new Range(new Base0Position(0, 28), new Base0Position(0, 35));
      const mergedRanges = Range.simplify([range1, range2, range3, range4, range5, range6]);
      expect(mergedRanges.join(', ')).to.equal(
        'Range[0:0 -> 0:8], Range[0:10 -> 0:20], Range[0:25 -> 0:35]',
      );
    });

    it('should merge adjacent ranges', () => {
      const range1 = new Range(new Base0Position(0, 0), new Base0Position(0, 5));
      const range2 = new Range(new Base0Position(0, 5), new Base0Position(0, 8));
      const range3 = new Range(new Base0Position(0, 8), new Base0Position(0, 10));
      const range4 = new Range(new Base0Position(0, 10), new Base0Position(0, 15));
      const range5 = new Range(new Base0Position(0, 15), new Base0Position(0, 20));
      const mergedRanges = Range.simplify([range1, range2, range3, range4, range5]);
      expect(mergedRanges.join(', ')).to.equal('Range[0:0 -> 0:20]');
    });

    it('should not merge non-overlapping ranges', () => {
      const range1 = new Range(new Base0Position(0, 0), new Base0Position(0, 5));
      const range2 = new Range(new Base0Position(0, 7), new Base0Position(0, 10));
      const range3 = new Range(new Base0Position(0, 12), new Base0Position(0, 15));
      const mergedRanges = Range.simplify([range1, range2, range3]);
      expect(mergedRanges.join(', ')).to.equal(
        'Range[0:0 -> 0:5], Range[0:7 -> 0:10], Range[0:12 -> 0:15]',
      );
    });

    it('should handle empty input', () => {
      const mergedRanges = Range.simplify([]);
      expect(mergedRanges).to.have.lengthOf(0);
    });

    it('should handle input with a single range', () => {
      const range = new Range(new Base0Position(0, 0), new Base0Position(0, 5));
      const mergedRanges = Range.simplify([range]);
      expect(mergedRanges.join(', ')).to.equal('Range[0:0 -> 0:5]');
    });

    it('should handle duplicated range', () => {
      const range1 = new Range(new Base0Position(0, 0), new Base0Position(0, 5));
      const range2 = new Range(new Base0Position(0, 0), new Base0Position(0, 5));
      const range3 = new Range(new Base0Position(0, 6), new Base0Position(0, 7));
      const range4 = new Range(new Base0Position(0, 6), new Base0Position(0, 7));
      const mergedRanges = Range.simplify([range1, range2, range3, range4]);
      expect(mergedRanges.join(', ')).to.equal('Range[0:0 -> 0:5], Range[0:6 -> 0:7]');
    });
  });
});
