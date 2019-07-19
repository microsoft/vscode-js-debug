/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { TestP } from '../test';

export function addTests(testRunner) {
  // @ts-ignore unused xit/fit variables.
  const { it, fit, xit, describe, fdescribe, xdescribe } = testRunner;

  describe('format', () => {
    it('format string', async ({ p }: { p: TestP }) => {
      let complete: () => void;
      const result = new Promise(f => complete = f);
      p.launchAndLoad(`
        <script>
          var svg = document.getElementById("svg-node");
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
          console.debug('DONE');
        </script>`);
      p.dap.on('output', async params => {
        if (params.category === 'stderr')
          complete();
        else
          await p.logger.logOutput(p, params);
      });
      await result;
      p.assertLog();
    });

    it('simple log', async ({ p }: { p: TestP }) => {
      p.launchAndLoad(`
        <script>
          console.log('Hello world');
        </script>`);
      await p.logger.logOutput(p, await p.dap.once('output'));
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
          await p.logger.logOutput(p, params);
      });

      await result;
      p.assertLog();
    });
  });

  describe('object', () => {
    it('simple array', async ({ p }: { p: TestP }) => {
      await p.launchAndLoad('blank');
      await p.logger.logEvaluateResult(p, 'var a = [1, 2, 3]; a.foo = 1; a');
      p.assertLog();
    });

    it('get set', async ({ p }: { p: TestP }) => {
      await p.launchAndLoad('blank');
      await p.logger.logEvaluateResult(p, `
        const a = {};
        Object.defineProperty(a, 'getter', { get: () => {} });
        Object.defineProperty(a, 'setter', { set: () => {} });
        Object.defineProperty(a, 'accessor', { get: () => {}, set: () => {} });
        a;`);
      p.assertLog();
    });

    it('deep accessor', async ({ p }: { p: TestP }) => {
      await p.launchAndLoad('blank');
      await p.logger.logEvaluateResult(p, `
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
      await p.logger.logEvaluateResult(p, 'document.head.children');
      p.assertLog();
    });
  });
}
