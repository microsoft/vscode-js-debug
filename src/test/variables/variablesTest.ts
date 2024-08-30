/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { expect } from 'chai';
import Dap from '../../dap/api';
import { Logger, walkVariables } from '../logger';
import { itIntegrates } from '../testIntegrationUtils';

describe('variables', () => {
  describe('basic', () => {
    itIntegrates('basic object', async ({ r }) => {
      const p = await r.launchAndLoad('blank');
      await p.logger.evaluateAndLog('({a: 1})');
      p.assertLog();
    });

    itIntegrates('simple log', async ({ r }) => {
      const p = await r.launch(`
        <script>
          console.log('Hello world');
        </script>`);
      p.load();
      await p.logger.logOutput(await p.dap.once('output'));
      p.assertLog();
    });

    itIntegrates('clear console', async ({ r }) => {
      let complete: () => void;
      const result = new Promise<void>(f => (complete = f));
      let chain = Promise.resolve();
      const p = await r.launch(`
        <script>
        console.clear();
        console.log('Hello world');
        console.clear();
        console.clear();
        console.log('Hello world');
        console.clear();
        console.error('DONE');
        </script>`);
      p.load();
      p.dap.on('output', async params => {
        chain = chain.then(async () => {
          if (params.category === 'stderr') complete();
          else await p.logger.logOutput(params);
        });
      });

      await result;
      p.assertLog();
    });
  });

  describe('object', () => {
    itIntegrates('simple array', async ({ r }) => {
      const p = await r.launchAndLoad('blank');
      await p.logger.evaluateAndLog('var a = [1, 2, 3]; a.foo = 1; a', { logInternalInfo: true });
      p.assertLog();
    });

    itIntegrates.skip('large array', async ({ r }) => {
      const p = await r.launchAndLoad('blank');
      await p.logger.evaluateAndLog('var a = new Array(110); a.fill(1); a', {
        logInternalInfo: true,
      });
      p.assertLog();
    });

    itIntegrates('get set', async ({ r }) => {
      const p = await r.launchAndLoad('blank');
      await p.logger.evaluateAndLog(`
        const a = {};
        Object.defineProperty(a, 'getter', { get: () => {} });
        Object.defineProperty(a, 'setter', { set: () => {} });
        Object.defineProperty(a, 'accessor', { get: () => {}, set: () => {} });
        a;`);
      p.assertLog();
    });

    itIntegrates('private props', async ({ r }) => {
      const p = await r.launchAndLoad('blank');
      await p.logger.evaluateAndLog(`
        class A { #foo = 'bar' }
        new A();`);
      p.assertLog();
    });

    itIntegrates('deep accessor', async ({ r }) => {
      const p = await r.launchAndLoad('blank');
      await p.logger.evaluateAndLog(`
        class Foo { get getter() {} }
        class Bar extends Foo { }
        new Bar();`);
      p.assertLog();
    });

    describe('customDescriptionGenerator', () => {
      itIntegrates('using function declaration', async ({ r }) => {
        const p = await r.launchAndLoad('blank', {
          customDescriptionGenerator:
            'function (def) { if (this.customDescription) return "using function: " + this.customDescription(); else return def }',
        });
        await p.logger.evaluateAndLog(`
          class Foo { get getter() {} }
          class Bar extends Foo { customDescription() { return 'Instance of bar'} }
          new Bar();`);
        p.assertLog();
      });

      itIntegrates('shows errors', async ({ r }) => {
        const p = await r.launchAndLoad('blank', {
          customDescriptionGenerator:
            'function (def) { if (this.customDescription) throw new Error("oh no!"); else return def }',
        });
        await p.logger.evaluateAndLog(`
          class Foo { get getter() {} }
          class Bar extends Foo { customDescription() { return 'Instance of bar'} }
          new Bar();`);
        p.assertLog();
      });

      itIntegrates('using statement syntax', async ({ r }) => {
        const p = await r.launchAndLoad('blank', {
          customDescriptionGenerator:
            'const hasCustomDescription = this.customDescription; "using statement: " + (hasCustomDescription ? this.customDescription() : defaultValue)',
        });
        await p.logger.evaluateAndLog(`
          class Foo { get getter() {} }
          class Bar extends Foo { customDescription() { return 'Instance of bar'} }
          new Bar();`);
        p.assertLog();
      });

      itIntegrates('using statement with return syntax', async ({ r }) => {
        const p = await r.launchAndLoad('blank', {
          customDescriptionGenerator:
            'const hasCustomDescription = this.customDescription; if (hasCustomDescription) { return "using statement return: " + this.customDescription() } else return defaultValue',
        });
        await p.logger.evaluateAndLog(`
          class Foo { get getter() {} }
          class Bar extends Foo { customDescription() { return 'Instance of bar'} }
          new Bar();`);
        p.assertLog();
      });

      itIntegrates('with arrays', async ({ r }) => {
        const p = await r.launchAndLoad('blank', {
          customDescriptionGenerator: `function (def) {
              return this.customDescription
                ? this.customDescription()
                : (Array.isArray(this)
                  ? "I'm an array"
                  : def); }`,
        });
        await p.logger.evaluateAndLog(`
          class Foo { get getter() {} }
          class Bar extends Foo { customDescription() { return 'Instance of bar'} }
          [new Bar(), new Foo(), 5, "test"];`);
        p.assertLog();
      });
    });

    describe('customPropertiesGenerator', () => {
      itIntegrates('works with customPropertiesGenerator method ', async ({ r }) => {
        const p = await r.launchAndLoad('blank', {
          customPropertiesGenerator:
            'function () { if (this.customPropertiesGenerator) return this.customPropertiesGenerator(); else return this; }',
        });
        await p.logger.evaluateAndLog(`
        class Foo { get getter() {} }
        class Bar extends Foo {
          constructor() {
            super();
            this.realProp = 'cc3';
          }

          customPropertiesGenerator() {
            const properties = Object.create(this.__proto__);
            return Object.assign(properties, this, { customProp1: 'aa1', customProp2: 'bb2' });
          }
        }
        new Bar();`);
        p.assertLog();
      });
    });

    itIntegrates('shows errors while generating properties', async ({ r }) => {
      const p = await r.launchAndLoad('blank', {
        customPropertiesGenerator:
          'function () { if (this.customPropertiesGenerator) throw new Error("Some error while generating properties"); else return this; }',
      });
      await p.logger.evaluateAndLog(`
      class Foo { get getter() {} }
      class Bar extends Foo {
        constructor() {
          super();
          this.realProp = 'cc3';
        }

        customPropertiesGenerator() {
          const properties = Object.create(this.__proto__);
          return Object.assign(properties, this, { customProp1: 'aa1', customProp2: 'bb2' });
        }
      }
      new Bar();`);
      p.assertLog();
    });
  });

  describe('web', () => {
    itIntegrates('tags', async ({ r }) => {
      const p = await r.launchAndLoad(`<head>
        <meta name='foo' content='bar'></meta>
        <title>Title</title>
      </head>`);
      await p.logger.evaluateAndLog('document.head.children');
      p.assertLog();
    });
  });

  describe('multiple threads', () => {
    itIntegrates('worker', async ({ r }) => {
      const p = await r.launchUrlAndLoad('worker.html');
      const outputs: { output: Dap.OutputEventParams; logger: Logger }[] = [];
      await Promise.all([
        (async () => outputs.push({ output: await p.dap.once('output'), logger: p.logger }))(),
        (async () => {
          const worker = await r.worker();
          outputs.push({ output: await worker.dap.once('output'), logger: worker.logger });
          outputs.push({ output: await worker.dap.once('output'), logger: worker.logger });
        })(),
      ]);

      outputs.sort((a, b) => {
        const aName = a?.output?.source?.name;
        const bName = b?.output?.source?.name;
        return aName && bName ? aName.localeCompare(bName) : 0;
      });
      for (const { output, logger } of outputs) await logger.logOutput(output);
      p.assertLog();
    });
  });

  describe('setVariable', () => {
    itIntegrates('basic', async ({ r }) => {
      const p = await r.launchAndLoad('blank');
      const v = await p.logger.evaluateAndLog(`window.x = ({foo: 42}); x`);

      p.log(`\nSetting "foo" to "{bar: 17}"`);
      const response = await p.dap.setVariable({
        variablesReference: v.variablesReference,
        name: 'foo',
        value: '{bar: 17}',
      });

      const v2: Dap.Variable = {
        ...response,
        variablesReference: response.variablesReference || 0,
        name: '<result>',
      };
      await p.logger.logVariable(v2);

      p.log(`\nOriginal`);
      await p.logger.logVariable(v);

      p.log(
        await p.dap.setVariable({
          variablesReference: v.variablesReference,
          name: 'foo',
          value: 'baz',
        }),
        '\nsetVariable failure: ',
      );
      p.assertLog();
    });

    itIntegrates('setExpression', async ({ r }) => {
      const p = await r.launchAndLoad('blank');
      p.cdp.Runtime.evaluate({
        expression: `
        (function foo() {
          let a = { b: 1 }
          let c = 'e';
          debugger;
          console.log(a.b, c);
        })()
      `,
      });

      const paused = await p.dap.once('stopped');
      const stack = await p.dap.stackTrace({ threadId: paused.threadId! });

      p.log(
        await p.dap.setExpression({
          expression: 'a.b',
          value: '42',
          frameId: stack.stackFrames[0].id,
        }),
        '\nsetExpression a: ',
      );

      p.log(
        await p.dap.setExpression({
          expression: 'c',
          value: '"hello " + "world"',
          frameId: stack.stackFrames[0].id,
        }),
        '\nsetExpression a: ',
      );

      p.dap.continue({ threadId: paused.threadId! });
      p.log('\n Vars:');
      await p.logger.logOutput(await p.dap.once('output'));
      p.assertLog();
    });

    itIntegrates('scope', async ({ r }) => {
      const p = await r.launchAndLoad('blank');
      p.cdp.Runtime.evaluate({
        expression: `
        (function foo() {
          let y = 'value of y';
          let z = 'value of z';
          debugger;
        })()
      `,
      });

      const paused = p.log(await p.dap.once('stopped'), 'stopped: ');
      const stack = await p.dap.stackTrace({ threadId: paused.threadId });
      const scopes = await p.dap.scopes({ frameId: stack.stackFrames[0].id });
      const scope = scopes.scopes[0];
      const v: Dap.Variable = {
        name: 'scope',
        value: scope.name,
        variablesReference: scope.variablesReference,
        namedVariables: scope.namedVariables,
        indexedVariables: scope.indexedVariables,
      };

      await p.logger.logVariable(v);

      p.log(`\nSetting "y" to "z"`);
      const response = await p.dap.setVariable({
        variablesReference: v.variablesReference,
        name: 'y',
        value: `z`,
      });

      const v2: Dap.Variable = {
        ...response,
        variablesReference: response.variablesReference || 0,
        name: '<result>',
      };
      await p.logger.logVariable(v2);

      p.log(`\nOriginal`);
      await p.logger.logVariable(v);

      p.assertLog();
    });

    itIntegrates('name mapping', async ({ r }) => {
      const p = await r.launchUrlAndLoad('minified/index.html');
      p.cdp.Runtime.evaluate({ expression: `test()` });
      const event = await p.dap.once('stopped');
      const stacks = await p.logger.logStackTrace(event.threadId!, Infinity);

      p.log('\nPreserves eval sourceURL (#1259):'); // https://github.com/microsoft/vscode-js-debug/issues/1259#issuecomment-1442584596
      p.log(
        await p.dap.evaluate({
          expression: 'arg1; thenSomethingInvalid()',
          context: 'repl',
          frameId: stacks[0].id,
        }),
      );

      await p.dap.continue({ threadId: event.threadId! });

      p.assertLog();
    });

    itIntegrates('evaluateName', async ({ r }) => {
      const p = await r.launchAndLoad('blank');
      p.cdp.Runtime.evaluate({
        expression: `
        (function foo() {
          let a = 'some string';
          let b = [1, 2, 3, 4];
          b.prop = '';
          let c = { $a: 1, _b: 2, c: 3, 'd d': 4, [42]: 5,
            e: { nested: [{ obj: true }]}, [Symbol('wut')]: 'wut' };
          debugger;
        })();
      `,
      });

      const paused = p.log(await p.dap.once('stopped'), 'stopped: ');
      const stack = await p.dap.stackTrace({ threadId: paused.threadId });
      const scopes = await p.dap.scopes({ frameId: stack.stackFrames[0].id });
      const scope = scopes.scopes[0];
      const v: Dap.Variable = {
        name: 'scope',
        value: scope.name,
        variablesReference: scope.variablesReference,
        namedVariables: scope.namedVariables,
        indexedVariables: scope.indexedVariables,
      };

      await walkVariables(p.dap, v, (variable, depth) => {
        p.log('  '.repeat(depth) + variable.evaluateName);
        return (
          !variable.name.startsWith('__')
          && !variable.name.startsWith('[[')
          && variable.name !== 'this'
        );
      });

      p.assertLog();
    });
  });

  itIntegrates('map variable without preview (#1824)', async ({ r }) => {
    const p = await r.launchAndLoad('blank');
    await p.logger.evaluateAndLog(`
      class A { #bar = new Map([[1, 2]]) }
      new A();`);
    p.assertLog();
  });

  itIntegrates('readMemory/writeMemory', async ({ r }) => {
    const p = await r.launchAndLoad('blank');
    p.cdp.Runtime.evaluate({
      expression: `
        (function foo() {
          let $memA = new WebAssembly.Memory({ initial: 1, maximum: 1 });
          let $memB = $memA.buffer.slice(0, 12);
          let $memC = new Uint8Array($memB);
          let $memD = new DataView($memB);
          let $memE = new Uint8Array($memB, 3, 8);

          for (let i = 0; i < $memC.length; i++) {
            $memC[i] = i;
          }

          debugger;
          console.log($memA, $memB, $memC, $memD);
        })()
      `,
    });

    const paused = await p.dap.once('stopped');
    const stack = await p.dap.stackTrace({ threadId: paused.threadId! });

    const scopes = await p.dap.scopes({ frameId: stack.stackFrames[0].id });
    const scope = scopes.scopes[0];
    const v: Dap.Variable = {
      name: 'scope',
      value: scope.name,
      variablesReference: scope.variablesReference,
      namedVariables: scope.namedVariables,
      indexedVariables: scope.indexedVariables,
    };

    let memB: Dap.Variable;
    let memE: Dap.Variable;

    await walkVariables(p.dap, v, async (variable, depth) => {
      if (!variable.name.startsWith('$mem')) {
        return depth < 2;
      }

      if (variable.name === '$memB') {
        memB = variable;
      } else if (variable.name === '$memE') {
        memE = variable;
      }

      expect(variable).to.have.property('memoryReference');

      const memory1 = await p.dap.readMemory({
        count: 20,
        memoryReference: variable.memoryReference!,
        offset: 0,
      });

      p.log(memory1, `${variable.name} [0, 20]`);

      const memory2 = await p.dap.readMemory({
        count: 10,
        memoryReference: variable.memoryReference!,
        offset: 5,
      });

      p.log(memory2, `${variable.name} [5, 10]`);

      return false;
    });

    const written = await p.dap.writeMemory({
      memoryReference: memB!.memoryReference!,
      data: Buffer.from('hello').toString('base64'),
      offset: 1,
    });

    p.log(written, 'write');

    const memory3 = await p.dap.readMemory({
      count: 10,
      memoryReference: memB!.memoryReference!,
    });

    p.log(memory3, 'read outcome');

    const written2 = await p.dap.writeMemory({
      memoryReference: memE!.memoryReference!,
      data: Buffer.from('helloworld').toString('base64'),
      offset: 1,
    });

    p.log(written2, 'write with offset');

    const memory4 = await p.dap.readMemory({
      count: 10,
      memoryReference: memB!.memoryReference!,
    });

    p.log(memory4, 'read outcome');

    p.assertLog();
  });
});
