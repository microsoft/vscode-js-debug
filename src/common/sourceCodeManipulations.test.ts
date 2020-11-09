/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { generate } from 'astring';
import { expect } from 'chai';
import { FunctionDeclaration } from 'estree';
import { assertAstEqual } from '../test/assertAstEqual';
import {
  functionToFunctionCall,
  parseSource,
  statementsToFunction,
} from './sourceCodeManipulations';

describe('sourceCodeManipulations', () => {
  describe('statementsToFunction', () => {
    const wrapped = (...str: string[]) =>
      [
        'function _generatedCode(a) {',
        '  try {',
        ...str,
        '  } catch (e) {',
        '    return e.stack || e.message || String(e);',
        '  }',
        '}',
      ].join('\n');

    const tcases = [
      {
        in: 'a',
        out: wrapped('return a;'),
      },
      {
        in: 'a += 2; return a',
        out: wrapped('a += 2;', 'return a;'),
      },
      {
        in: 'a += 2; a',
        out: wrapped('a += 2;', 'return a;'),
      },
      {
        in: 'function(x) { return x }',
        out: wrapped('return (function (x) { return x; }).call(this, a);'),
      },
    ];

    for (const { in: input, out } of tcases) {
      it(input, () => {
        const parsed = parseSource(input);
        const transformed = statementsToFunction(['a'], parsed, true);
        assertAstEqual(generate(transformed), out);
      });
    }
  });

  it('functionToFunctionCall', () => {
    const parsed = parseSource('function(x) { return x }') as FunctionDeclaration[];
    const transformed = functionToFunctionCall(['x'], {
      type: 'FunctionExpression',
      id: null,
      params: [{ type: 'Identifier', name: 'x' }],
      body: parsed[0].body,
    });

    expect(generate(transformed)).to.equal(['(function (x) {', '  return x;', '})(x)'].join('\n'));
  });
});
