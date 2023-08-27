/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { expect } from 'chai';
import { binarySearch } from './arrayUtils';

describe('arrayUtils', () => {
  describe('binarySearch', () => {
    it('should return negative position for element not in array', () => {
      expect(binarySearch([], 1, (a, b) => a - b)).to.equal(0);
      expect(binarySearch([1, 2, 3], 4, (a, b) => a - b)).to.equal(3);
      expect(binarySearch([1, 2, 3], 1.5, (a, b) => a - b)).to.equal(1);
      expect(binarySearch([1, 2, 3], 0, (a, b) => a - b)).to.equal(0);
    });

    it('should return index of key in array', () => {
      expect(binarySearch([1, 2, 3], 2, (a, b) => a - b)).to.equal(1);
    });

    it('should return index of key in array with duplicates', () => {
      expect(binarySearch([1, 2, 2, 3], 2, (a, b) => a - b)).to.equal(1);
    });

    it('should return index of key in array with custom comparator', () => {
      const arr = [{ id: 1 }, { id: 2 }, { id: 3 }];
      expect(binarySearch(arr, { id: 2 }, (a, b) => a.id - b.id)).to.equal(1);
    });
  });
});
