/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as assert from 'assert';
import { expect } from 'chai';
import { LinkedList } from './linkedList';

describe('LinkedList', function() {
  function assertElements<E>(list: LinkedList<E>, ...elements: E[]) {
    // check size
    assert.strictEqual(list.size, elements.length);

    // assert toArray
    assert.deepStrictEqual(Array.from(list), elements);

    // assert Symbol.iterator (1)
    assert.deepStrictEqual([...list], elements);

    // assert Symbol.iterator (2)
    for (const item of list) {
      assert.strictEqual(item, elements.shift());
    }
    assert.strictEqual(elements.length, 0);
  }

  it('Push/Iter', () => {
    const list = new LinkedList<number>();
    list.push(0);
    list.push(1);
    list.push(2);
    assertElements(list, 0, 1, 2);
  });

  it('Push/Remove', () => {
    let list = new LinkedList<number>();
    let disp = list.push(0);
    list.push(1);
    list.push(2);
    disp();
    assertElements(list, 1, 2);

    list = new LinkedList<number>();
    list.push(0);
    disp = list.push(1);
    list.push(2);
    disp();
    assertElements(list, 0, 2);

    list = new LinkedList<number>();
    list.push(0);
    list.push(1);
    disp = list.push(2);
    disp();
    assertElements(list, 0, 1);

    list = new LinkedList<number>();
    list.push(0);
    list.push(1);
    disp = list.push(2);
    disp();
    disp();
    assertElements(list, 0, 1);
  });

  it('Push/toArray', () => {
    const list = new LinkedList<string>();
    list.push('foo');
    list.push('bar');
    list.push('far');
    list.push('boo');

    assertElements(list, 'foo', 'bar', 'far', 'boo');
  });

  it('unshift/Iter', () => {
    const list = new LinkedList<number>();
    list.unshift(0);
    list.unshift(1);
    list.unshift(2);
    assertElements(list, 2, 1, 0);
  });

  it('unshift/Remove', () => {
    let list = new LinkedList<number>();
    let disp = list.unshift(0);
    list.unshift(1);
    list.unshift(2);
    disp();
    assertElements(list, 2, 1);

    list = new LinkedList<number>();
    list.unshift(0);
    disp = list.unshift(1);
    list.unshift(2);
    disp();
    assertElements(list, 2, 0);

    list = new LinkedList<number>();
    list.unshift(0);
    list.unshift(1);
    disp = list.unshift(2);
    disp();
    assertElements(list, 1, 0);
  });

  it('unshift/toArray', () => {
    const list = new LinkedList<string>();
    list.unshift('foo');
    list.unshift('bar');
    list.unshift('far');
    list.unshift('boo');
    assertElements(list, 'boo', 'far', 'bar', 'foo');
  });

  it('pop/unshift', function() {
    const list = new LinkedList<string>();
    list.push('a');
    list.push('b');

    assertElements(list, 'a', 'b');

    const a = list.shift();
    assert.strictEqual(a, 'a');
    assertElements(list, 'b');

    list.unshift('a');
    assertElements(list, 'a', 'b');

    const b = list.pop();
    assert.strictEqual(b, 'b');
    assertElements(list, 'a');
  });

  // #region custom methods
  it('applyFilter', () => {
    const list = new LinkedList<number>();
    list.push(0);
    list.push(1);
    list.push(2);
    list.push(3);
    list.push(4);
    list.push(5);
    list.applyFilter(x => x < 2 || x > 4);
    expect([...list]).to.deep.equal([0, 1, 5]);
  });
  // #endregion
});
