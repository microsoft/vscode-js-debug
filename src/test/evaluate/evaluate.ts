/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import {TestP} from '../test';
import * as vscode from 'vscode';

export function addTests(testRunner) {
  // @ts-ignore unused xit/fit variables.
  const {it, fit, xit} = testRunner;

  it('evaluateBasic', async({p} : {p : TestP}) => {
    await p.launchAndLoad('blank');

    const r1 = p.log(await p.dap.evaluate({expression: `42`}));
    p.log(`No variables: ${r1.variablesReference === 0}`);

    const r2 = p.log(await p.dap.evaluate({expression: `'42'`}));
    p.log(`No variables: ${r2.variablesReference === 0}`);

    const r3 = p.log(await p.dap.evaluate({expression: `({foo: 42})`}));
    p.log(await p.dap.variables({variablesReference: r3.variablesReference}), 'Variables: ');
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

