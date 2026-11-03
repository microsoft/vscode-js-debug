/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { readFileSync, readlinkSync } from 'fs';
import { LocalFsUtils } from '../../common/fsUtils';
import { DarwinProcessTree } from './darwinProcessTree';
import { IProcess } from './processTree';

/**
 * Reads what procfs knows about a process. Each method returns undefined if
 * the process exited after ps listed it, if it can't be read, or if there is
 * no procfs.
 */
export interface IProcfs {
  /** NUL delimited argv, from /proc/<pid>/cmdline */
  cmdline(pid: number): string | undefined;
  /** Path of the running executable, from /proc/<pid>/exe */
  exe(pid: number): string | undefined;
}

const procfs: IProcfs = {
  cmdline: pid => {
    try {
      return readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    } catch {
      return undefined;
    }
  },
  exe: pid => {
    try {
      return readlinkSync(`/proc/${pid}/exe`);
    } catch {
      return undefined;
    }
  },
};

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
    // argv. If the command line starts with the executable's path, it ends
    // there, spaces or not. A title like pm2's "node <script>" doesn't.
    if (argv?.length === 1) {
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
