/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { expect } from 'chai';
import { Base1Position } from './positions';
import { StackTraceLocation, StackTraceParser } from './stackTraceParser';

describe('StackTraceParser', () => {
  it('parses a stack trace', () => {
    const stack = `TypeError: Cannot read properties of undefined (reading '0')
      at Object.<anonymous> (/home/bousse-e/Téléchargements/idl/monprojet/build/hello.js:2:2)
      at Module._compile (node:internal/modules/cjs/loader:1103:14)
      at Object.Module._extensions..js (node:internal/modules/cjs/loader:1155:10)
      at node:internal/main/run_main_module:17:47
    `;

    expect([...new StackTraceParser(stack)]).to.deep.equal([
      "TypeError: Cannot read properties of undefined (reading '0')\n",
      '      at Object.<anonymous> (',
      new StackTraceLocation(
        '/home/bousse-e/Téléchargements/idl/monprojet/build/hello.js',
        new Base1Position(2, 2),
      ),
      ')',
      '\n',
      '      at Module._compile (',
      new StackTraceLocation('node:internal/modules/cjs/loader', new Base1Position(1103, 14)),
      `)`,
      '\n',
      '      at Object.Module._extensions..js (',
      new StackTraceLocation('node:internal/modules/cjs/loader', new Base1Position(1155, 10)),
      `)`,
      '\n',
      '      at ',
      new StackTraceLocation('node:internal/main/run_main_module', new Base1Position(17, 47)),
      '\n',
      '    \n',
    ]);
  });
});
