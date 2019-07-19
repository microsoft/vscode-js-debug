// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { TestP } from '../test';
import { logVariable } from './helper';

export function addTests(testRunner) {
  // @ts-ignore unused xit/fit variables.
  const { it, fit, xit, describe, fdescribe, xdescribe } = testRunner;

  describe('basic', () => {
    it('basic object', async ({ p }: { p: TestP }) => {
      await p.launchAndLoad('data:text/html,blank');
      const object = await p.dap.evaluate({ expression: `({a: 1})`, });
      await logVariable({ name: 'result', value: object.result, ...object }, p);
      p.assertLog();
    });

    it('simple log', async ({ p }: { p: TestP }) => {
      await p.launchAndLoad('data:text/html,blank');
      p.dap.evaluate({ expression: `console.log('Hello world')`, });
      const log = await p.dap.once('output');
      if (log.variablesReference)
        await logVariable({
          variablesReference: log.variablesReference,
          name: log.category as string,
          value: log.output}, p, 3);
      p.assertLog();
    });
  });
}

