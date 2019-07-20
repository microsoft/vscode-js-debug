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
}

