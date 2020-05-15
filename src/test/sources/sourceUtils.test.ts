/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { wrapObjectLiteral } from '../../common/sourceUtils';
import { expect } from 'chai';
import { LogPointCompiler } from '../../adapter/breakpoints/conditions/logPoint';
import { Logger } from '../../common/logging/logger';

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

  const wrapped = (...stmts: string[]) =>
    [
      '(() => {',
      '  try {',
      ...stmts.map(s => `    ${s}`),
      '  } catch (e) {',
      '    return e.stack || e.message || String(e);',
      '  }',
      '})()',
    ].join('\n');

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
        `console.log("hello %O", ${wrapped('n++;', 'return v=() => { return true };')})`,
      ],
      'invalid empty': ['hello {}!', 'console.log("hello {}!")'],
      'invalid unclosed': ['hello {!', 'console.log("hello {!")'],
      'invalid unclosed at end': ['hello {', 'console.log("hello {")'],
    };

    for (const name of Object.keys(cases)) {
      const [input, expected] = cases[name];
      it(name, async () => {
        const compiler = new LogPointCompiler(Logger.null, {
          prepare: () => ({ canEvaluateDirectly: true }),
        } as any);
        const compiled = compiler.compile({ line: 0 }, input).breakCondition as string;
        expect(compiled.slice(0, compiled.lastIndexOf('\n'))).to.equal(expected);
      });
    }
  });
});
