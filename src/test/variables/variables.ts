// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { TestP } from '../test';
import Dap from '../../dap/api';
import { logVariable } from './helper';

export function addTests(testRunner) {
  // @ts-ignore unused xit/fit variables.
  const { it, fit, xit, describe, fdescribe, xdescribe } = testRunner;

  describe('basic', () => {
    fit('simple object', async ({ p }: { p: TestP }) => {
      await p.launchAndLoad('data:text/html,blank');
      const params: Dap.EvaluateParams = {
        expression: `({a: 1})`,
        context: undefined
      };
      const object = await p.dap.evaluate(params) as Dap.EvaluateResult;
      await logVariable({ name: 'result', value: object.result, ...object }, p);
      p.assertLog();
    });
  });
}

