/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { wrapObjectLiteral } from '../../common/sourceUtils';
import { expect } from 'chai';

describe('sourceUtils', () => {
  describe('wrapObjectLiteral', () => {
    const cases: [string, string][] = [
      ['', ''],
      ['foo()', 'foo()'],
      ['{ foo: true }', '({ foo: true })'],
      ['{ foo: await true }', '({ foo: await true })'],
      ['{ function foo() {} }', '{ function foo() {} }'],
      ['{ function invalid(', '{ function invalid('],
    ];

    for (const [input, output] of cases) {
      it(input, () => expect(wrapObjectLiteral(input)).to.equal(output));
    }
  });
});
