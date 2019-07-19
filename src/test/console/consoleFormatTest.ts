/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { TestP } from '../test';

export function addTests(testRunner) {
  // @ts-ignore unused xit/fit variables.
  const { it, fit, xit, describe, fdescribe, xdescribe } = testRunner;

  async function evaluateAndLogAllConsoleEntries(p: TestP, expression: string) {
    let complete: () => void;
    const result = new Promise(f => complete = f);
    let chain = Promise.resolve();
    p.dap.on('output', async params => {
      chain = chain.then(async () => {
        if (params.category === 'stderr')
          complete();
        else
          await p.logger.logOutput(params);
      });
    });
    expression = expression + ';console.error("---done-for-test---");';
    const res = await p.dap.evaluate({ expression });
    await result;
  }

  describe('format', () => {
    it('format string', async ({ p }: { p: TestP }) => {
      await p.launchAndLoad('blank');
      await evaluateAndLogAllConsoleEntries(p, `
        var array = ["test", "test2"];array.length = 10;
        array.foo = {};
        array[4] = "test4";

        console.log(array);
        console.log("%o", array);
        console.log("%O", array);
        console.log("Test for zero \\"%f\\" in formatter", 0);
        console.log("%% self-escape1", "dummy");
        console.log("%%s self-escape2", "dummy");
        console.log("%%ss self-escape3", "dummy");
        console.log("%%s%s%%s self-escape4", "dummy");
        console.log("%%%%% self-escape5", "dummy");
        console.log("%%%s self-escape6", "dummy");
        console.error('DONE');`);
      p.assertLog();
    });
  });
}
