/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { wrapObjectLiteral } from '../../common/sourceUtils';
import { expect } from 'chai';
import { logMessageToExpression } from '../../adapter/breakpoints/logPoint';

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

  const wrapped = (text: string) => `(() => {
    try {${text}
    } catch (e) {
      return e.stack || e.message || String(e);
    }
  })()`;

  describe('logMessageToExpression', () => {
    const cases: { [name: string]: [string, string] } = {
      'simple text': ['hello', 'console.log("hello")'],
      suffix: ['hello {name}', `console.log("hello %O", ${wrapped('return name;')})`],
      infix: ['hello {name}!', `console.log("hello %O!", ${wrapped('return name;')})`],
      prefix: ['{greet} world', `console.log("%O world", ${wrapped('return greet;')})`],
      multi: [
        '{greet} {name}!',
        `console.log("%O %O!", ${wrapped('return greet;')}, ${wrapped('return name;')})`,
      ],
      unreturned: ['{throw "foo"}!', `console.log("%O!", ${wrapped('throw "foo";')})`],
      escaping: [
        'greet%:o%"\' {greet} name:%"\'  {name} %',
        `console.log("greet%%:o%%\\"' %O name:%%\\"'  %O %%", ${wrapped(
          'return greet;',
        )}, ${wrapped('return name;')})`,
      ],
      'complex expression': [
        'hello {n++;v=() => { return true }}',
        `console.log("hello %O", (() => {
    try {n++;return v=() => { return true };
    } catch (e) {
      return e.stack || e.message || String(e);
    }
  })())`,
      ],
      'invalid empty': ['hello {}!', 'console.log("hello {}!")'],
      'invalid unclosed': ['hello {!', 'console.log("hello {!")'],
      'invalid unclosed at end': ['hello {', 'console.log("hello {")'],
    };

    for (const name of Object.keys(cases)) {
      const [input, expected] = cases[name];
      it(name, () => expect(logMessageToExpression(input)).to.equal(expected));
    }
  });
});
