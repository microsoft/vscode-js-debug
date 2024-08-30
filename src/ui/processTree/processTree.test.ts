/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { expect } from 'chai';
import { analyseArguments } from './processTree';

describe('process tree', () => {
  describe('analyze arguments', () => {
    const tt = [
      { input: 'node --inspect', address: '127.0.0.1', port: 9229 },
      { input: 'node --inspect=:1234', address: '127.0.0.1', port: 1234 },
      { input: 'node --inspect=0.0.0.0', address: '0.0.0.0', port: 9229 },
      { input: 'node --inspect=0.0.0.0:1234', address: '0.0.0.0', port: 1234 },
      { input: 'node --inspect=[::1]:1234', address: '[::1]', port: 1234 },

      { input: 'node --inspect-brk', address: '127.0.0.1', port: 9229 },
      { input: 'node --inspect-brk=0.0.0.0', address: '0.0.0.0', port: 9229 },
      { input: 'node --inspect-brk=0.0.0.0:1234', address: '0.0.0.0', port: 1234 },
      { input: 'node --inspect-brk=[::1]:1234', address: '[::1]', port: 1234 },

      {
        input: 'node --inspect-brk=0.0.0.0:1234 --inspect-port=3456',
        address: '0.0.0.0',
        port: 3456,
      },
    ];

    for (const t of tt) {
      it(`should analyze ${t.input}`, () => {
        const a = analyseArguments(t.input);
        expect(a).to.deep.equal({
          address: t.address,
          port: t.port,
        });
      });
    }
  });
});
