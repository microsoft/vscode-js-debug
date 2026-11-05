/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { expect } from 'chai';
import {
  mkdirSync,
  mkdtempSync,
  promises as fsPromises,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { LocalFsUtils } from '../../common/fsUtils';
import { createProcfs, PosixProcessTree } from './posixProcessTree';
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
        name: 'node 25 without arguments, through a symlink at a path with spaces',
        comm: 'node-MainThread',
        input: '/tmp/node 25/node',
        cmdline: '/tmp/node 25/node\0',
        // exe has the symlink resolved, so it differs from argv[0], but
        // argv[0] links to the same file
        exe: '/opt/node25/bin/node',
        links: ['/tmp/node 25/node'],
        command: '/tmp/node 25/node',
        args: '',
        listed: true,
      },
      {
        name: 'node 24 without arguments, through a symlink at a path with spaces',
        comm: 'MainThread',
        input: '/tmp/node 24/node',
        cmdline: '/tmp/node 24/node\0',
        exe: '/opt/node24/bin/node',
        links: ['/tmp/node 24/node'],
        command: '/tmp/node 24/node',
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
          isExe: (_pid, path) => !!t.links?.includes(path),
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

    it('should parse symlinked executables at paths with spaces from procfs', function() {
      // procfs is Linux only, and symlinks need extra rights on Windows
      if (process.platform === 'win32') {
        return this.skip();
      }

      // A fake procfs, laid out like Linux's: cmdline keeps the spelling the
      // process was started with, exe links to the resolved executable, and
      // cwd and root link to the process's directories.
      const dir = mkdtempSync(join(tmpdir(), 'js-debug-procfs-'));
      try {
        const node = join(dir, 'opt', 'node');
        mkdirSync(join(dir, 'opt'));
        writeFileSync(node, '');
        for (const version of ['25', '24']) {
          mkdirSync(join(dir, `node ${version}`));
          symlinkSync(node, join(dir, `node ${version}`, 'node'));
        }

        // a container's root, where "/my apps/node" only resolves through root
        const rootfs = join(dir, 'rootfs');
        mkdirSync(join(rootfs, 'usr', 'bin'), { recursive: true });
        writeFileSync(join(rootfs, 'usr', 'bin', 'node'), '');
        mkdirSync(join(rootfs, 'my apps'));
        symlinkSync('../usr/bin/node', join(rootfs, 'my apps', 'node'));

        const proc = (pid: number, cmdline: string, exe = node, root = '/') => {
          const entry = join(dir, 'proc', String(pid));
          mkdirSync(entry, { recursive: true });
          writeFileSync(join(entry, 'cmdline'), cmdline);
          symlinkSync(exe, join(entry, 'exe'));
          symlinkSync(dir, join(entry, 'cwd'));
          symlinkSync(root, join(entry, 'root'));
        };
        const absolute = join(dir, 'node 25', 'node');
        proc(4242, `${absolute}\0`);
        proc(4243, './node 24/node\0');
        proc(4244, 'node /home/me/app/server.js\0\0\0\0');
        proc(4245, '/my apps/node\0', join(rootfs, 'usr', 'bin', 'node'), rootfs);
        // the pid was reused after ps listed it
        proc(4246, `${absolute}\0`);

        const tree = new TestPosixProcessTree(
          new LocalFsUtils(fsPromises),
          createProcfs(join(dir, 'proc')),
        );
        const parsed = tree.parse([
          row('PID', 'PPID', 'COMMAND', 'COMMAND'),
          row('4242', '1', 'node-MainThread', absolute),
          row('4243', '1', 'MainThread', './node 24/node'),
          row('4244', '1', 'node /home/me/a', 'node /home/me/app/server.js'),
          row('4245', '1', 'node-MainThread', '/my apps/node'),
          row('4246', '1', 'node', 'node /app/x.js'),
        ]);
        expect(parsed).to.deep.equal([
          { pid: 4242, ppid: 1, command: absolute, args: '' },
          { pid: 4243, ppid: 1, command: './node 24/node', args: '' },
          { pid: 4244, ppid: 1, command: 'node', args: '/home/me/app/server.js' },
          { pid: 4245, ppid: 1, command: '/my apps/node', args: '' },
          { pid: 4246, ppid: 1, command: 'node', args: '/app/x.js' },
        ]);
        for (const p of parsed) {
          expect(getPickerEntry(p)).to.deep.equal({ executableName: 'node', port: undefined });
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
