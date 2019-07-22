/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { TestP } from '../test';

export function addTests(testRunner) {
  // @ts-ignore unused xit/fit variables.
  const { it, fit, xit, describe, fdescribe, xdescribe } = testRunner;

  describe('format', () => {
    it('format string', async ({ p }: { p: TestP }) => {
      await p.launchAndLoad(`blank`);
      await p.logger.evaluateAndLog([
        `console.log('Log')`,
        `console.info('Info')`,
        `console.warn('Warn')`,
        `console.error('Error')`,
        `console.assert(false, 'Assert')`,
        `console.assert(false)`,
        `console.trace('Trace')`,
        `console.count('Counter')`,
        `console.count('Counter')`,
      ], 1);
      p.assertLog();
    });
  });
}
