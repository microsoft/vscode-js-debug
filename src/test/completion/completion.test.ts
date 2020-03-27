/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { itIntegrates } from '../testIntegrationUtils';
import { expect } from 'chai';
import Dap from '../../dap/api';

describe('completion', () => {
  const tcases: [string, Dap.CompletionItem[]][] = [
    ['ar|', [{ label: 'arr', sortText: '~~arr', type: 'variable' }]],
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
          sortText: '~~length',
          type: 'property',
        },
        {
          label: 'concat',
          sortText: '~~~concat',
          type: 'method',
        },
      ],
    ],
    ['arr[|', []],
    [
      'arr[0].|',
      [
        {
          label: 'length',
          sortText: '~~length',
          type: 'property',
        },
        {
          label: 'anchor',
          sortText: '~~~anchor',
          type: 'method',
        },
        {
          label: 'big',
          sortText: '~~~big',
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
          sortText: '~~bar',
          type: 'property',
        },
        {
          label: 'baz',
          sortText: '~~baz',
          type: 'method',
        },
        {
          label: 'foo',
          sortText: '~~foo',
          type: 'property',
        },
      ],
    ],
    ['ob|', [{ label: 'obj', sortText: '~~obj', type: 'variable' }]],
    ['arr[myStr|', [{ label: 'myString', sortText: '~~myString', type: 'variable' }]],
    ['const replVar = 42; replV|', [{ label: 'replVar', sortText: 'replVar', type: 'variable' }]],
    ['MyCoolCl|', [{ label: 'MyCoolClass', sortText: '~~MyCoolClass', type: 'class' }]],
    ['Strin|', [{ label: 'String', sortText: '~~String', type: 'class' }]],
    ['myNeatFun|', [{ label: 'myNeatFunction', sortText: '~~myNeatFunction', type: 'function' }]],
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
          sortText: '~~length',
          type: 'property',
        },
        {
          label: 'concat',
          sortText: '~~~concat',
          type: 'method',
        },
      ],
    ],
    [
      'poison.|',
      [
        { label: 'bar', sortText: '~~bar', type: 'property' },
        { label: 'foo', sortText: '~~foo', type: 'property' },
        { label: 'constructor', sortText: '~~~constructor', type: 'class' },
      ],
    ],
    [
      'hasPrivate.|',
      [
        { label: 'c', sortText: '~~c', type: 'property' },
        { label: '_a', sortText: '~~{a', type: 'property' },
        { label: '__b', sortText: '~~{{b', type: 'property' },
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
        },
        { label: 'constructor', sortText: '~~~constructor', type: 'class' },
        { label: 'hasOwnProperty', sortText: '~~~hasOwnProperty', type: 'method' },
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
