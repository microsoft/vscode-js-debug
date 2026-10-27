/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { expect } from 'chai';
import { promises as fsPromises } from 'fs';
import { LocalFsUtils } from '../../common/fsUtils';
import { PosixProcessTree } from './posixProcessTree';
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

  describe('posix ps output', () => {
    class TestPosixProcessTree extends PosixProcessTree {
      public parse(lines: string[]) {
        const parser = this.createParser();
        return lines.map(parser).filter(p => !!p);
      }
    }

    // procps labels both the comm and command columns COMMAND, right aligns
    // the ids, and pads comm to the 30 columns that PosixProcessTree asks for.
    const row = (pid: string, ppid: string, comm: string, command: string) =>
      `${pid.padStart(7)} ${ppid.padStart(7)} ${comm.padEnd(30)} ${command}`;

    const tt = [
      {
        name: 'node',
        comm: 'node',
        input: '/usr/bin/node /app/server.js',
        command: '/usr/bin/node',
        args: '/app/server.js',
      },
      {
        name: 'node 24, whose main thread is named MainThread',
        comm: 'MainThread',
        input: 'node /app/server.js',
        command: 'node',
        args: '/app/server.js',
      },
      {
        name: 'node 24 without arguments',
        comm: 'MainThread',
        input: 'node',
        command: 'node',
        args: '',
      },
      {
        name: 'node 25, whose main thread is named node-MainThread',
        comm: 'node-MainThread',
        input: '/usr/local/bin/node /app/server.js',
        command: '/usr/local/bin/node',
        args: '/app/server.js',
      },
      {
        name: 'a pm2 app, whose title is "node <script>"',
        comm: 'node /home/me/a',
        input: 'node /home/me/app/server.js',
        command: 'node',
        args: '/home/me/app/server.js',
      },
      {
        name: 'a process that set its title',
        comm: 'my-long-server-',
        input: 'my-long-server-name',
        command: 'my-long-server-name',
        args: '',
      },
    ];

    for (const t of tt) {
      it(`should parse ${t.name}`, () => {
        const tree = new TestPosixProcessTree(new LocalFsUtils(fsPromises));
        const parsed = tree.parse([
          row('PID', 'PPID', 'COMMAND', 'COMMAND'),
          row('4242', '1', t.comm, t.input),
        ]);
        expect(parsed).to.deep.equal([{ pid: 4242, ppid: 1, command: t.command, args: t.args }]);
      });
    }
  });
});
