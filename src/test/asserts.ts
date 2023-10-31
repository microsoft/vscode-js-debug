/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { AssertionError, expect } from 'chai';
import { delay } from '../common/promiseUtil';
import { parseProgram, traverse } from '../common/sourceCodeManipulations';

export const assertAstEqual = (a: string, b: string) => {
  const locationFreeParse = (str: string) =>
    traverse(parseProgram(str), {
      enter(node: any) {
        delete node.loc;
        delete node.end;
        delete node.start;
      },
    });

  try {
    expect(locationFreeParse(a)).to.deep.equal(locationFreeParse(b));
  } catch {
    throw new Error(`Expected\n\n${a}\n\n to be equivalent to\n\n${b}`);
  }
};

const unset = Symbol('unset');

export const assertResolved = async <T>(p: Promise<T>): Promise<T> => {
  let r: T | typeof unset = unset;
  p.then(rv => {
    r = rv;
  });

  await delay(0);

  if (r === unset) {
    throw new AssertionError('Promise not resolved');
  }

  return r;
};

export const assertNotResolved = async <T>(p: Promise<T>): Promise<void> => {
  let r: T | typeof unset = unset;
  p.then(rv => {
    r = rv;
  });

  await delay(0);

  if (r !== unset) {
    throw new AssertionError('Promise unexpectedly resolved');
  }
};
