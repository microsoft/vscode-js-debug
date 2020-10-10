/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { expect } from 'chai';
import { traverse } from 'estraverse';
import { parseProgram } from '../common/sourceCodeManipulations';

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
