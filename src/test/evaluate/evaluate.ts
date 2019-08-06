// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {TestP} from '../test';
import * as sourceUtils from '../../utils/sourceUtils';

export function addTests(testRunner) {
  // @ts-ignore unused xit/fit variables.
  const {it, fit, xit} = testRunner;

  it('default', async ({ p }: { p: TestP }) => {
    await p.launchUrl('index.html');

    await p.logger.evaluateAndLog(`42`);
    p.log('');

    await p.logger.evaluateAndLog(`'foo'`);
    p.log('');

    await p.logger.evaluateAndLog(`1234567890n`);
    p.log('');

    await p.logger.evaluateAndLog(`throw new Error('foo')`);
    p.log('');

    await p.logger.evaluateAndLog(`throw {foo: 3, bar: 'baz'};`);
    p.log('');

    await p.logger.evaluateAndLog(`throw 42;`);
    p.log('');

    await p.logger.evaluateAndLog(`{foo: 3}`);
    p.log('');

    await p.logger.evaluateAndLog(`baz();`);
    p.log('');

    p.evaluate(`setTimeout(() => { throw new Error('bar')}, 0)`);
    await p.logger.logOutput(await p.dap.once('output'));
    p.log('');

    p.dap.evaluate({expression: `setTimeout(() => { throw new Error('baz')}, 0)`});
    await p.logger.logOutput(await p.dap.once('output'));
    p.log('');

    await p.addScriptTag('browserify/bundle.js');

    await p.logger.evaluateAndLog(`window.throwError('error1')`);
    p.log('');

    await p.logger.evaluateAndLog(`window.throwValue({foo: 3, bar: 'baz'})`);
    p.log('');

    p.dap.evaluate({expression: `setTimeout(() => { window.throwError('error2')}, 0)`});
    await p.logger.logOutput(await p.dap.once('output'));
    p.log('');

    p.assertLog();
  });

  it('repl', async ({ p }: { p: TestP }) => {
    await p.launchUrl('index.html');

    p.dap.evaluate({expression: `42`, context: 'repl'});
    await p.logger.logOutput(await p.dap.once('output'));
    p.log('');

    p.dap.evaluate({expression: `'foo'`, context: 'repl'});
    await p.logger.logOutput(await p.dap.once('output'));
    p.log('');

    p.dap.evaluate({expression: `1234567890n`, context: 'repl'});
    await p.logger.logOutput(await p.dap.once('output'));
    p.log('');

    p.dap.evaluate({expression: `throw new Error('foo')`, context: 'repl'});
    await p.logger.logOutput(await p.dap.once('output'));
    p.log('');

    p.dap.evaluate({expression: `throw {foo: 3, bar: 'baz'};`, context: 'repl'});
    await p.logger.logOutput(await p.dap.once('output'));
    p.log('');

    p.dap.evaluate({expression: `throw 42;`, context: 'repl'});
    await p.logger.logOutput(await p.dap.once('output'));
    p.log('');

    p.dap.evaluate({expression: `{foo: 3}`, context: 'repl'});
    await p.logger.logOutput(await p.dap.once('output'));
    p.log('');

    p.dap.evaluate({expression: `baz();`, context: 'repl'});
    await p.logger.logOutput(await p.dap.once('output'));
    p.log('');

    p.dap.evaluate({expression: `setTimeout(() => { throw new Error('bar')}, 0); 42`, context: 'repl'});
    const r1 = await p.dap.once('output');
    const e1 = await p.dap.once('output');
    await p.logger.logOutput(r1);
    await p.logger.logOutput(e1);
    p.log('');

    p.dap.evaluate({expression: `setTimeout(() => { throw new Error('baz')}, 0); 42`, context: 'repl'});
    const r2 = await p.dap.once('output');
    const e2 = await p.dap.once('output');
    await p.logger.logOutput(r2);
    await p.logger.logOutput(e2);
    p.log('');

    await p.addScriptTag('browserify/bundle.js');

    p.dap.evaluate({expression: `window.throwError('error1')`, context: 'repl'});
    await p.logger.logOutput(await p.dap.once('output'));
    p.log('');

    p.dap.evaluate({expression: `window.throwValue({foo: 3, bar: 'baz'})`, context: 'repl'});
    await p.logger.logOutput(await p.dap.once('output'));
    p.log('');

    p.dap.evaluate({expression: `setTimeout(() => { window.throwError('error2')}, 0); 42`, context: 'repl'});
    const r3 = await p.dap.once('output');
    const e3 = await p.dap.once('output');
    await p.logger.logOutput(r3);
    await p.logger.logOutput(e3);
    p.log('');

    p.assertLog();
  });

  it('copy', async({p} : {p: TestP}) => {
    await p.launchAndLoad('blank');
    await p.dap.evaluate({expression: 'var x = "hello"; copy(x)'});
    await p.dap.evaluate({expression: 'copy(123n)'});
    await p.dap.evaluate({expression: 'copy(NaN)'});
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
      const rewritten = sourceUtils.rewriteTopLevelAwait(code);
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
    ], { depth: 0 }, 'repl');
    p.assertLog();
  });

  it('output slots', async({p} : {p: TestP}) => {
    await p.launchAndLoad('blank');
    const empty = await p.dap.evaluate({expression: 'let i = 0; console.log(++i); ++i', context: 'repl'});
    const console = await p.dap.once('output');
    const result = await p.dap.once('output');
    await p.logger.logEvaluateResult(empty);
    await p.logger.logOutput(console);
    await p.logger.logOutput(result);
    p.assertLog();
  });

  it('output slots 2', async({p} : {p: TestP}) => {
    await p.launchAndLoad('blank');
    const empty = await p.dap.evaluate({expression: `
      let i = 0;
      setTimeout(() => {
        console.log(++i);
        throw {foo: ++i};
      }, 0);
      ++i
    `, context: 'repl'});
    const result = await p.dap.once('output');
    const console = await p.dap.once('output');
    const exception = await p.dap.once('output');
    await p.logger.logEvaluateResult(empty);
    await p.logger.logOutput(result);
    await p.logger.logOutput(console);
    await p.logger.logOutput(exception);
    p.assertLog();
  });

  it('selected context', async({p} : {p: TestP}) => {
    await p.launchUrl('worker.html');
    p.log('Pausing...');
    p.dap.evaluate({expression: `window.w.postMessage('pause');`, context: 'repl'});
    const {threadId} = await p.dap.once('stopped');
    p.log('Paused');

    p.log('Evaluating in page');
    await p.logger.evaluateAndLog('self', {depth: 0});
    p.dap.continue({threadId: threadId!});
    await p.dap.once('continued');
    p.log('Resumed');

    p.log('Evaluating in worker');
    const workerContext = p.uberAdapter.targetList()[0].children()[0];
    p.adapter.setThread(p.uberAdapter.thread(workerContext));
    await p.logger.evaluateAndLog('self', {depth: 0});

    p.assertLog();
  });
}

