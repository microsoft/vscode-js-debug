/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { TestP } from '../test';
import { logOutput, logEvaluateResult } from './helper';

export function addTests(testRunner) {
  // @ts-ignore unused xit/fit variables.
  const { it, fit, xit, describe, fdescribe, xdescribe } = testRunner;

  describe('basic', () => {
    it('basic object', async ({ p }: { p: TestP }) => {
      await p.launchAndLoad('blank');
      await logEvaluateResult(p, '({a: 1})');
      p.assertLog();
    });

    it('simple log', async ({ p }: { p: TestP }) => {
      p.launchAndLoad(`
        <script>
          console.log('Hello world');
        </script>`);
      await logOutput(p, await p.dap.once('output'));
      p.assertLog();
    });

    it('clear console', async ({ p }: { p: TestP }) => {
      let complete: () => void;
      const result = new Promise(f => complete = f);
      p.launchAndLoad(`
        <script>
        console.clear();
        console.log('Hello world');
        console.clear();
        console.clear();
        console.log('Hello world');
        console.clear();
        console.error('DONE');
        </script>`);
      p.dap.on('output', async params => {
        if (params.category === 'stderr')
          complete();
        else
          await logOutput(p, params);
      });

      await result;
      p.assertLog();
    });
  });

  describe('object', () => {
    it('simple array', async ({ p }: { p: TestP }) => {
      await p.launchAndLoad('blank');
      await logEvaluateResult(p, 'var a = [1, 2, 3]; a.foo = 1; a');
      p.assertLog();
    });

    it('get set', async ({ p }: { p: TestP }) => {
      await p.launchAndLoad('blank');
      await logEvaluateResult(p, `
        const a = {};
        Object.defineProperty(a, 'getter', { get: () => {} });
        Object.defineProperty(a, 'setter', { set: () => {} });
        Object.defineProperty(a, 'accessor', { get: () => {}, set: () => {} });
        a;`);
      p.assertLog();
    });

    it('deep accessor', async ({ p }: { p: TestP }) => {
      await p.launchAndLoad('blank');
      await logEvaluateResult(p, `
        class Foo { get getter() {} }
        class Bar extends Foo { }
        new Bar();`);
      p.assertLog();
    });
  });

  describe('web', () => {
    it('tags', async ({ p }: { p: TestP }) => {
      await p.launchAndLoad(`<head>
        <meta name='foo' content='bar'></meta>
        <title>Title</title>
      </head>`);
      await logEvaluateResult(p, 'document.head.children');
      p.assertLog();
    });
  });
}
