/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { expect } from 'chai';
import { promises as fsPromises } from 'fs';
import { LocalFsUtils } from '../../common/fsUtils';
import { PosixProcessTree } from './posixProcessTree';
import { analyseArguments, getPickerEntry } from './processTree';

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
        cmdline: '/usr/bin/node\0/app/server.js\0',
        command: '/usr/bin/node',
        args: '/app/server.js',
        listed: true,
      },
      {
        name: 'node 24, whose main thread is named MainThread',
        comm: 'MainThread',
        input: 'node /app/server.js',
        cmdline: 'node\0/app/server.js\0',
        command: 'node',
        args: '/app/server.js',
        listed: true,
      },
      {
        name: 'node 24 without arguments',
        comm: 'MainThread',
        input: 'node',
        cmdline: 'node\0',
        exe: '/usr/bin/node',
        command: 'node',
        args: '',
        listed: true,
      },
      {
        name: 'node 25, whose main thread is named node-MainThread',
        comm: 'node-MainThread',
        input: '/usr/local/bin/node /app/server.js',
        cmdline: '/usr/local/bin/node\0/app/server.js\0',
        command: '/usr/local/bin/node',
        args: '/app/server.js',
        listed: true,
      },
      {
        name: 'node 25 with its thread name in the script path',
        comm: 'node-MainThread',
        input: 'node /app/node-MainThread/server.js',
        cmdline: 'node\0/app/node-MainThread/server.js\0',
        command: 'node',
        args: '/app/node-MainThread/server.js',
        listed: true,
      },
      {
        name: 'node 24 with --inspect and its thread name in the script path',
        comm: 'MainThread',
        input: 'node --inspect=127.0.0.1:19238 /app/MainThread/server.js',
        cmdline: 'node\0--inspect=127.0.0.1:19238\0/app/MainThread/server.js\0',
        command: 'node',
        args: '--inspect=127.0.0.1:19238 /app/MainThread/server.js',
        port: 19238,
        listed: true,
      },
      {
        name: 'node 24 at a path with spaces',
        comm: 'MainThread',
        input: '/opt/my apps/node /app/server.js',
        cmdline: '/opt/my apps/node\0/app/server.js\0',
        command: '/opt/my apps/node',
        args: '/app/server.js',
        listed: true,
      },
      {
        name: 'node 24 without arguments at a path with spaces',
        comm: 'MainThread',
        input: '/opt/my apps/node',
        cmdline: '/opt/my apps/node\0',
        exe: '/opt/my apps/node',
        command: '/opt/my apps/node',
        args: '',
        listed: true,
      },
      {
        name: 'a process whose pid was reused before procfs was read',
        comm: 'node-MainThread',
        input: 'node /app/node-MainThread/server.js',
        cmdline: 'python3\0x.py\0',
        command: 'node',
        args: '/app/node-MainThread/server.js',
        listed: true,
      },
      {
        name: 'node 25 with its thread name in a later argument, without procfs',
        comm: 'node-MainThread',
        input: 'node --inspect=9229 --require /srv/node-MainThread /app/server.js',
        cmdline: undefined,
        command: 'node',
        args: '--inspect=9229 --require /srv/node-MainThread /app/server.js',
        port: 9229,
        listed: true,
      },
      {
        name: 'node at a path with spaces, without procfs',
        comm: 'node',
        input: '/opt/nodejs apps/node /app/server.js',
        cmdline: undefined,
        command: '/opt/nodejs apps/node',
        args: '/app/server.js',
        listed: true,
      },
      {
        name: 'a pm2 app, whose title is "node <script>"',
        comm: 'node /home/me/a',
        input: 'node /home/me/app/server.js',
        // the title is written over argv, and the rest of argv is zeroed
        cmdline: 'node /home/me/app/server.js\0\0\0\0\0\0\0\0',
        exe: '/usr/bin/node',
        command: 'node',
        args: '/home/me/app/server.js',
        listed: true,
      },
      {
        name: 'a process that set its title',
        comm: 'my-long-server-',
        input: 'my-long-server-name',
        cmdline: 'my-long-server-name\0\0\0\0',
        command: 'my-long-server-name',
        args: '',
        listed: false,
      },
    ];

    for (const t of tt) {
      it(`should parse ${t.name}`, () => {
        const tree = new TestPosixProcessTree(new LocalFsUtils(fsPromises), {
          cmdline: () => t.cmdline,
          exe: () => t.exe,
        });
        const parsed = tree.parse([
          row('PID', 'PPID', 'COMMAND', 'COMMAND'),
          row('4242', '1', t.comm, t.input),
        ]);
        expect(parsed).to.deep.equal([{ pid: 4242, ppid: 1, command: t.command, args: t.args }]);
        expect(getPickerEntry(parsed[0])).to.deep.equal(
          t.listed ? { executableName: 'node', port: t.port } : undefined,
        );
      });
    }

    it('should parse a process that exited before procfs was read', () => {
      // Linux pids are below 2^22, so procfs never has this one
      const tree = new TestPosixProcessTree(new LocalFsUtils(fsPromises));
      const args = '--inspect=127.0.0.1:19238 /app/MainThread/server.js';
      const parsed = tree.parse([
        row('PID', 'PPID', 'COMMAND', 'COMMAND'),
        row('4194304', '1', 'MainThread', `node ${args}`),
      ]);
      expect(parsed).to.deep.equal([{ pid: 4194304, ppid: 1, command: 'node', args }]);
      expect(getPickerEntry(parsed[0])).to.deep.equal({ executableName: 'node', port: 19238 });
    });
  });
});
