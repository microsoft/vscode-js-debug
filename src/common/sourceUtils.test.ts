/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { expect } from 'chai';
import { LogPointCompiler } from '../adapter/breakpoints/conditions/logPoint';
import { assertAstEqual } from '../test/asserts';
import { rewriteTopLevelAwait, wrapObjectLiteral } from './sourceUtils';

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
        `console.log("greet%%:o%%\\"' %O name:%%\\"'  %O %%", ${
          wrapped(
            'return greet;',
          )
        }, ${wrapped('return name;')})`,
      ],
      'complex expression': [
        'hello {n++;v=() => { return true }}',
        `console.log("hello %O", ${wrapped('n++;', 'return v = () => {', '  return true;', '};')})`,
      ],
      'invalid empty': ['hello {}!', 'console.log("hello {}!")'],
      'invalid unclosed': ['hello {!', 'console.log("hello {!")'],
      'invalid unclosed at end': ['hello {', 'console.log("hello {")'],
    };

    for (const name of Object.keys(cases)) {
      const [input, expected] = cases[name];
      it(name, async () => {
        const compiler = new LogPointCompiler({
          prepare: () => ({ canEvaluateDirectly: true }),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);
        const compiled = compiler.compile({ line: 0 }, input).breakCondition as string;
        expect(compiled.slice(0, compiled.lastIndexOf('\n'))).to.equal(`${expected}, false`);
      });
    }
  });

  describe('rewriteTopLevelAwait', () => {
    const tcases: [string, string | undefined][] = [
      ['0', undefined],
      ['await 0', '(async () => {return (await 0)\n})()'],
      ['async function foo() { await 0; }', undefined],
      ['async () => await 0', undefined],
      ['class A { async method() { await 0 } }', undefined],
      ['await 0; return 0;', undefined],
      ['var a = await 1', '(async () => {void( a = await 1)\n})()'],
      ['let a = await 1', '(async () => {void( a = await 1)\n})()'],
      ['const a = await 1', '(async () => {void( a = await 1)\n})()'],
      [
        'for (var i = 0; i < 1; ++i) { await i }',
        '(async () => {for (void( i = 0); i < 1; ++i) { await i }\n})()',
      ],
      [
        'for (let i = 0; i < 1; ++i) { await i }',
        '(async () => {for (let i = 0; i < 1; ++i) { await i }\n})()',
      ],
      [
        'var {a} = {a:1}, [b] = [1], {c:{d}} = {c:{d: await 1}}',
        '(async () => {void (( {a} = {a:1}),( [b] = [1]),( {c:{d}} = {c:{d: await 1}}))\n})()',
      ],
      [
        'console.log(`${(await {a:1}).a}`)',
        '(async () => {return (console.log(`${(await {a:1}).a}`))\n})()',
      ],
      ['await 0;function foo() {}', '(async () => {await 0;foo=function foo() {}\n})()'],
      ['await 0;class Foo {}', '(async () => {await 0;Foo=class Foo {}\n})()'],
      [
        'if (await true) { function foo() {} }',
        '(async () => {if (await true) {foo= function foo() {} }\n})()',
      ],
      ['if (await true) { class Foo{} }', '(async () => {if (await true) { class Foo{} }\n})()'],
      ['if (await true) { var a = 1; }', '(async () => {if (await true) { void( a = 1); }\n})()'],
      ['if (await true) { let a = 1; }', '(async () => {if (await true) { let a = 1; }\n})()'],
      [
        'var a = await 1; let b = 2; const c = 3;',
        '(async () => {void( a = await 1); void( b = 2); void( c = 3);\n})()',
      ],
      ['let o = await 1, p', '(async () => {void (( o = await 1),( p=undefined))\n})()'],
      [
        'for await (const number of asyncRandomNumbers()) {}',
        '(async () => {for await (const number of asyncRandomNumbers()) {}\n})()',
      ],
      [
        "[...(await fetch('url', { method: 'HEAD' })).headers.entries()]",
        "(async () => {return ([...(await fetch('url', { method: 'HEAD' })).headers.entries()])\n})()",
      ],
      ['await 1\n//hello', '(async () => {return (await 1)\n//hello\n})()'],
      [
        'var {a = await new Promise(resolve => resolve({a:123}))} = {a : 3}',
        '(async () => {void( {a = await new Promise(resolve => resolve({a:123}))} = {a : 3})\n})()',
      ],
      ['await 1; for (var a of [1,2,3]);', '(async () => {await 1; for (var a of [1,2,3]);\n})()'],
      [
        'for (let j = 0; j < 5; ++j) { await j; }',
        '(async () => {for (let j = 0; j < 5; ++j) { await j; }\n})()',
      ],
    ];

    for (const [input, output] of tcases) {
      it(input, () => {
        const transformed = rewriteTopLevelAwait(input);
        if (transformed === undefined || output === undefined) {
          expect(transformed).to.equal(output);
        } else {
          assertAstEqual(transformed, output);
        }
      });
    }
  });
});
