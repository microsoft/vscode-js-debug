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
          text: '[',
          type: 'property',
          sortText: '~~[',
          length: 1,
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
  ];

  itIntegrates('completion', async ({ r }) => {
    const p = await r.launchAndLoad(`
      <script>
        var arr = ['', {}, null];
        var obj = { foo: '', bar: 42, baz() {} };
        var myString = '';
        var MyCoolClass = class MyCoolClass {} // need to be hoisted manually
        function myNeatFunction() {}
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
});
