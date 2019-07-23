/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import {TestP} from '../test';
import * as vscode from 'vscode';

export function addTests(testRunner) {
  // @ts-ignore unused xit/fit variables.
  const {it, fit, xit} = testRunner;

  it('default', async ({ p }: { p: TestP }) => {
    await p.launchUrl('index.html');

    await p.logger.logEvaluateResult(`42`);
    p.log('');

    await p.logger.logEvaluateResult(`'foo'`);
    p.log('');

    await p.logger.logEvaluateResult(`1234567890n`);
    p.log('');

    await p.logger.logEvaluateResult(`throw new Error('foo')`);
    p.log('');

    // TODO(dgozman): should these not return the exception?
    await p.logger.logEvaluateResult(`throw {foo: 3, bar: 'baz'};`);
    p.log('');

    await p.logger.logEvaluateResult(`throw 42;`);
    p.log('');

    await p.logger.logEvaluateResult(`{foo: 3}`);
    p.log('');

    await p.logger.logEvaluateResult(`baz();`);
    p.log('');

    p.evaluate(`setTimeout(() => { throw new Error('bar')}, 0)`);
    await p.logger.logOutput(await p.dap.once('output'));
    p.log('');

    p.dap.evaluate({expression: `setTimeout(() => { throw new Error('baz')}, 0)`});
    await p.logger.logOutput(await p.dap.once('output'));
    p.log('');

    await p.addScriptTag('browserify/bundle.js');

    await p.logger.logEvaluateResult(`window.throwError('error1')`);
    p.log('');

    await p.logger.logEvaluateResult(`window.throwValue({foo: 3, bar: 'baz'})`);
    p.log('');

    p.dap.evaluate({expression: `setTimeout(() => { window.throwError('error2')}, 0)`});
    await p.logger.logOutput(await p.dap.once('output'));
    p.log('');

    p.assertLog();
  });

  it('copy', async({p} : {p: TestP}) => {
    await p.launchAndLoad('blank');
    await p.dap.evaluate({expression: 'var x = "hello"; copy(x)'});
    p.log(await vscode.env.clipboard.readText());
    await p.dap.evaluate({expression: 'copy(123n)'});
    p.log(await vscode.env.clipboard.readText());
    await p.dap.evaluate({expression: 'copy(NaN)'});
    p.log(await vscode.env.clipboard.readText());
    p.assertLog();
  });

  it('queryObjects', async({p} : {p: TestP}) => {
    await p.launchAndLoad('blank');
    await p.dap.evaluate({expression: `
      class Foo {
        constructor(value) {
          this.value = value;
        }
      }
      var foo1 = new Foo(1);
      var foo2 = new Foo(2);
    `});
    p.dap.evaluate({expression: 'queryObjects(Foo)'});
    await p.logger.logOutput(await p.dap.once('output'));
    p.assertLog();
  });

  it('rewriteTopLevelAwait', async({p} : {p: TestP}) => {
    await p.launchAndLoad('blank');
    const tests = [
      '0',
      'await 0',
      'async function foo() { await 0; }',
      'async () => await 0',
      'class A { async method() { await 0 } }',
      'await 0; return 0;',
      'var a = await 1',
      'let a = await 1',
      'const a = await 1',
      'for (var i = 0; i < 1; ++i) { await i }',
      'for (let i = 0; i < 1; ++i) { await i }',
      'var {a} = {a:1}, [b] = [1], {c:{d}} = {c:{d: await 1}}',
      'console.log(`${(await {a:1}).a}`)',
      'await 0;function foo() {}',
      'await 0;class Foo {}',
      'if (await true) { function foo() {} }',
      'if (await true) { class Foo{} }',
      'if (await true) { var a = 1; }',
      'if (await true) { let a = 1; }',
      'var a = await 1; let b = 2; const c = 3;',
      'let o = await 1, p',
      'for await (const number of asyncRandomNumbers()) {}',
      '[...(await fetch(\'url\', { method: \'HEAD\' })).headers.entries()]',
      'await 1\n//hello',
      'var {a = await new Promise(resolve => resolve({a:123}))} = {a : 3}',
      'await 1; for (var a of [1,2,3]);',
      'for (let j = 0; j < 5; ++j) { await j; }',
    ];

    for (const code of tests) {
      p.log('------');
      p.log(code);
      const rewritten = p.adapter.rewriteTopLevelAwait(code);
      p.log(rewritten || '<ignored>');
    }

    p.assertLog();
  });

  it('topLevelAwait', async({p} : {p: TestP}) => {
    await p.launchAndLoad(`
      <script>
        function foo(x) {
          return x;
        }

        function koo() {
          return Promise.resolve(4);
        }
      </script>
    `);
    await p.logger.evaluateAndLog([
      'await Promise.resolve(1)',
      '{a:await Promise.resolve(1)}',
      '$_',
      'let {a,b} = await Promise.resolve({a: 1, b:2}), f = 5;',
      'a',
      'b',
      'let c = await Promise.resolve(2)',
      'c',
      'let d;',
      'd',
      'let [i,{abc:{k}}] = [0,{abc:{k:1}}];',
      'i',
      'k',
      'var l = await Promise.resolve(2);',
      'l',
      'foo(await koo());',
      '$_',
      'const m = foo(await koo());',
      'm',
      'const n = foo(await\nkoo());',
      'n',
      '`status: ${(await Promise.resolve({status:200})).status}`',
      'for (let i = 0; i < 2; ++i) await i',
      'for (let i = 0; i < 2; ++i) { await i }',
      'await 0',
      'await 0;function foo(){}',
      'foo',
      'class Foo{}; await 1;',
      'Foo',
      'await 0;function* gen(){}',
      'for (var i = 0; i < 10; ++i) { await i; }',
      'i',
      'for (let j = 0; j < 5; ++j) { await j; }',
      'j',
      'gen',
      'await 5; return 42;',
      'let o = await 1, p',
      'p',
      'let q = 1, s = await 2',
      's',
      'await {...{foo: 42}}'
    ], 0, 'repl');
    p.assertLog();
  });
}

