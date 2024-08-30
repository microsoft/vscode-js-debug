/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { expect } from 'chai';
import Dap from '../../dap/api';
import { itIntegrates } from '../testIntegrationUtils';

describe('completion', () => {
  const tcases: [string, Dap.CompletionItem[]][] = [
    ['ar|', [{ label: 'arr', sortText: '~~arr', type: 'variable', detail: 'Array' }]],
    ['ar|.length', [{ label: 'arr', sortText: '~~arr', type: 'variable', detail: 'Array' }]],
    [
      'arr.|',
      [
        {
          label: '[index]',
          text: '[index]',
          type: 'property',
          sortText: '~~[',
          length: 1,
          selectionLength: 5,
          selectionStart: 1,
          start: 3,
        },
        {
          label: 'length',
          detail: '3',
          sortText: '~~length',
          type: 'property',
        },
        {
          label: 'at',
          detail: 'fn(?)',
          sortText: '~~~at',
          type: 'method',
        },
      ],
    ],
    [
      'arr.len|',
      [
        {
          label: '[index]',
          text: '[index]',
          type: 'property',
          sortText: '~~[',
          length: 1,
          selectionLength: 5,
          selectionStart: 1,
          start: 3,
        },
        {
          label: 'length',
          detail: '3',
          sortText: '~~length',
          type: 'property',
        },
      ],
    ],
    ['arr[|', []],
    [
      'arr[0].|',
      [
        {
          label: 'length',
          detail: '0',
          sortText: '~~length',
          type: 'property',
        },
        {
          label: 'anchor',
          detail: 'fn(?)',
          sortText: '~~~anchor',
          type: 'method',
        },
        {
          label: 'at',
          detail: 'fn(?)',
          sortText: '~~~at',
          type: 'method',
        },
      ],
    ],
    ['arr[2].|', []],
    [
      'obj.|',
      [
        {
          label: 'bar',
          detail: '42',
          sortText: '~~bar',
          type: 'property',
        },
        {
          label: 'baz',
          detail: 'fn()',
          sortText: '~~baz',
          type: 'method',
        },
        {
          label: 'foo',
          detail: 'string',
          sortText: '~~foo',
          type: 'property',
        },
      ],
    ],
    ['ob|', [{ label: 'obj', sortText: '~~obj', type: 'variable', detail: 'Object' }]],
    [
      'arr[myStr|',
      [{ label: 'myString', sortText: '~~myString', type: 'variable', detail: 'string' }],
    ],
    ['const replVar = 42; replV|', [{
      label: 'replVar',
      sortText: 'replVar',
      type: 'variable',
    }]],
    [
      'MyCoolCl|',
      [{ label: 'MyCoolClass', sortText: '~~MyCoolClass', type: 'class', detail: 'fn()' }],
    ],
    ['Strin|', [{ label: 'String', sortText: '~~String', type: 'class', detail: 'fn(?)' }]],
    [
      'myNeatFun|',
      [
        {
          label: 'myNeatFunction',
          sortText: '~~myNeatFunction',
          type: 'function',
          detail: 'fn()',
        },
      ],
    ],
    [
      'new Array(42).|',
      [
        {
          label: '[index]',
          text: '[index]',
          type: 'property',
          sortText: '~~[',
          length: 1,
          selectionLength: 5,
          selectionStart: 1,
          start: 13,
        },
        {
          label: 'length',
          detail: '42',
          sortText: '~~length',
          type: 'property',
        },
        {
          label: 'at',
          detail: 'fn(?)',
          sortText: '~~~at',
          type: 'method',
        },
      ],
    ],
    [
      'poison.|',
      [
        { label: 'bar', sortText: '~~bar', type: 'property', detail: 'true' },
        { label: 'foo', sortText: '~~foo', type: 'property' },
        { label: 'constructor', sortText: '~~~constructor', type: 'class', detail: 'fn(?)' },
      ],
    ],
    [
      'hasPrivate.|',
      [
        { label: 'c', sortText: '~~c', type: 'property', detail: '3' },
        { label: '_a', sortText: '~~{a', type: 'property', detail: '1' },
        { label: '__b', sortText: '~~{{b', type: 'property', detail: '2' },
      ],
    ],
    [
      'complexProp.|',
      [
        {
          label: 'complex prop',
          text: '["complex prop"]',
          start: 11,
          length: 1,
          type: 'property',
          sortText: '~~complex prop',
          detail: 'true',
        },
        { label: 'constructor', sortText: '~~~constructor', type: 'class', detail: 'fn(?)' },
        {
          label: 'hasOwnProperty',
          sortText: '~~~hasOwnProperty',
          type: 'method',
          detail: 'fn(?)',
        },
      ],
    ],
    ['$returnV|', []],
  ];

  itIntegrates('completion', async ({ r }) => {
    const p = await r.launchAndLoad(`
      <script>
        var arr = ['', {}, null];
        var obj = { foo: '', bar: 42, baz() {} };
        var myString = '';
        var MyCoolClass = class MyCoolClass {} // need to be hoisted manually
        function myNeatFunction() {}
        var hasPrivate = { _a: 1, __b: 2, c: 3 };
        var poison = { get foo() { throw new Error('oh no!') }, bar: true };
        var complexProp = { 'complex prop': true };
      </script>
    `);

    for (const [completion, expected] of tcases) {
      const index = completion.indexOf('|');
      const actual = await p.dap.completions({
        text: completion.slice(0, index) + completion.slice(index + 1),
        column: index + 1,
      });

      expect(actual.targets.slice(0, 3)).to.deep.equal(
        expected,
        `bad result evaluating ${completion}`,
      );
    }
  });

  itIntegrates('completes in scope (vscode#153651)', async ({ r }) => {
    const p = await r.launch(`
      <script>
        function foo() {
          const helloWorld = '';
          debugger;
        }

        foo();
      </script>
    `);

    const untilStopped = p.dap.once('stopped');
    p.load();

    const frame = (
      await p.dap.stackTrace({
        threadId: (await untilStopped).threadId!,
      })
    ).stackFrames[0];

    const actual = await p.dap.completions({
      text: 'helloW',
      column: 7,
      frameId: frame.id,
    });

    expect(actual.targets).to.deep.equal([
      {
        label: 'helloWorld',
        type: 'property',
      },
    ]);
  });

  itIntegrates('$returnValue', async ({ r }) => {
    const getFrameId = async () =>
      (
        await p.dap.stackTrace({
          threadId: threadId!,
        })
      ).stackFrames[0].id;

    const p = await r.launchAndLoad(`
      <script>
        function foo() {
          debugger;
          return { a: { b: 2 }};
        }
      </script>
    `);

    p.dap.evaluate({ expression: 'foo() ' });

    const { threadId } = await p.dap.once('stopped');
    await p.dap.next({ threadId: threadId! }); // step past debugger;
    await p.dap.once('stopped');

    // no returnValue when not in a returned context
    const a1 = await p.dap.completions({
      text: '$returnValu',
      column: 11,
      frameId: await getFrameId(),
    });
    expect(a1.targets).to.not.containSubset([
      {
        sortText: '~$returnValue',
      },
    ]);

    await p.dap.next({ threadId: threadId! }); // step past return;
    await p.dap.once('stopped');

    // returnValue is available
    const frameId = await getFrameId();
    const a2 = await p.dap.completions({
      text: '$returnValu',
      column: 11,
      frameId,
    });

    expect(a2.targets).to.containSubset([
      {
        label: '$returnValue',
        type: 'variable',
        sortText: '~$returnValue',
      },
    ]);

    // returnValue can be completed on
    const a3 = await p.dap.completions({
      text: '$returnValue.',
      column: 14,
      frameId,
    });

    expect(a3.targets).to.containSubset([
      {
        label: 'a',
        sortText: '~~a',
        type: 'property',
      },
    ]);
  });
});
