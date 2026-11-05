/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { readFileSync, readlinkSync, statSync } from 'fs';
import { LocalFsUtils } from '../../common/fsUtils';
import { DarwinProcessTree } from './darwinProcessTree';
import { IProcess } from './processTree';

/**
 * Reads what procfs knows about a process. Each method returns undefined (or
 * false) if the process exited after ps listed it, if it can't be read, or if
 * there is no procfs.
 */
export interface IProcfs {
  /** NUL delimited argv, from /proc/<pid>/cmdline */
  cmdline(pid: number): string | undefined;
  /** Path of the running executable, from /proc/<pid>/exe */
  exe(pid: number): string | undefined;
  /**
   * Whether the path, as the process sees it, is the file it runs. Symlinks
   * are followed, and a relative path starts at the process's cwd.
   */
  isExe(pid: number, path: string): boolean;
}

/**
 * Reads procfs at the given directory. Tests can point it at a fake one.
 */
export const createProcfs = (dir = '/proc'): IProcfs => ({
  cmdline: pid => {
    try {
      return readFileSync(`${dir}/${pid}/cmdline`, 'utf8');
    } catch {
      return undefined;
    }
  },
  exe: pid => {
    try {
      return readlinkSync(`${dir}/${pid}/exe`);
    } catch {
      return undefined;
    }
  },
  isExe: (pid, path) => {
    // resolve the path from the process's own root or cwd, as it would
    const file = path.startsWith('/') ? `${dir}/${pid}/root${path}` : `${dir}/${pid}/cwd/${path}`;
    try {
      const a = statSync(file, { bigint: true });
      const b = statSync(`${dir}/${pid}/exe`, { bigint: true });
      return a.dev === b.dev && a.ino === b.ino;
    } catch {
      return false;
    }
  },
});

const procfs = createProcfs();

export class PosixProcessTree extends DarwinProcessTree {
  public constructor(
    fsUtils: LocalFsUtils,
    private readonly proc: IProcfs = procfs,
  ) {
    super(fsUtils);
  }

  /**
   * @inheritdoc
   */
  protected createProcess() {
    return this.spawn('ps', ['-axo', `pid=PID,ppid=PPID,comm:30,command=COMMAND`]);
  }

  /**
   * @inheritdoc
   */
  protected createParser(): (line: string) => IProcess | void {
    const parser = super.createParser();
    return line => {
      const process = parser(line);
      if (!process) {
        return;
      }

      const end = this.getExecutableEnd(process.pid, process.command, process.args);
      process.command = process.args.slice(0, end);
      process.args = process.args.slice(end + 1);
      return process;
    };
  }

  /**
   * Gets the index at which the executable ends in the command line.
   */
  private getExecutableEnd(pid: number, comm: string, commandLine: string) {
    // procfs delimits argv with NULs, so argv[0] is the executable even if its
    // path has spaces. comm can't tell where it ends: Node 24 and 25 rename
    // the main thread, which renames comm, and that name can also appear in a
    // script path or another argument.
    const argv = this.proc.cmdline(pid)?.replace(/\0+$/, '').split('\0');
    if (argv && argv.length > 1 && commandLine.startsWith(`${argv[0]} `)) {
      return argv[0].length;
    }

    // A single argv entry is the executable alone or a title written over
    // argv. If a path with spaces is the running file, it's the executable;
    // compare files, since exe has symlinks resolved and argv[0] doesn't. (A
    // name without a slash was found on PATH, so it isn't checked.) Otherwise,
    // if the command line starts with exe's path, it ends there. A title like
    // pm2's "node <script>" is neither.
    if (argv?.length === 1) {
      const [path] = argv;
      const spacedPath = path.includes('/') && /\s/.test(path);
      if (spacedPath && commandLine === path && this.proc.isExe(pid, path)) {
        return path.length;
      }

      const exe = this.proc.exe(pid);
      if (exe && (commandLine === exe || commandLine.startsWith(`${exe} `))) {
        return exe.length;
      }
    }

    // Otherwise, look for comm where it ends a path, before the first option,
    // and use the first word if it's not there. A comm with spaces is a title,
    // not a binary name: pm2 sets "node <script>", so use the first word then.
    if (comm && !/\s/.test(comm)) {
      const option = commandLine.indexOf(' -');
      const head = option === -1 ? commandLine : commandLine.slice(0, option);
      for (let i = head.indexOf(comm); i !== -1; i = head.indexOf(comm, i + 1)) {
        const end = i + comm.length;
        if ((i === 0 || head[i - 1] === '/') && (head[end] ?? ' ') === ' ') {
          return end;
        }
      }
    }

    const space = commandLine.indexOf(' ');
    return space === -1 ? commandLine.length : space;
  }
}
