/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { promises as fsPromises } from 'fs';
import { basename } from 'path';
import { LocalFsUtils } from '../../common/fsUtils';
import { once } from '../../common/objUtils';
import { DarwinProcessTree } from './darwinProcessTree';
import { PosixProcessTree } from './posixProcessTree';
import { WindowsProcessTree } from './windowsProcessTree';

/**
 * IProcess is parsed from the {@link IProcessTree}
 */
export interface IProcess {
  /**
   * Process ID.
   */
  pid: number;
  /**
   * Parent process ID, or 0.
   */
  ppid: number;

  /**
   * Binary or command used to start the process.
   */
  command: string;

  /**
   * Process arguments.
   */
  args: string;

  /**
   * Time at which the process was started.
   */
  date?: number;
}

/**
 * Device that looks up processes running on the current machine.
 */
export interface IProcessTree {
  /**
   * Looks up process in the tree, accumulating them into a result.
   */
  lookup<T>(onEntry: (process: IProcess, accumulator: T) => T, initial: T): Promise<T>;

  /**
   * Gets the working directory of the process, if possible.
   */
  getWorkingDirectory(processId: number): Promise<string | undefined>;
}

/**
 * The process tree implementation for the current platform.
 */
// TODO: Figure out how to inject the fsUtils here
const fsUtils = new LocalFsUtils(fsPromises);
export const processTree: IProcessTree = process.platform === 'win32'
  ? new WindowsProcessTree()
  : process.platform === 'darwin'
  ? new DarwinProcessTree(fsUtils)
  : new PosixProcessTree(fsUtils);

const DEBUG_FLAGS_PATTERN = once(() => {
  const parts = [
    // base inspect argument
    '--inspect(?:-brk)?',

    // START = argument. (Note that --inspect does not allow a space delimiter, so no need to handle it)
    '(?:=',

    // Host+port or port alternate:
    [
      '(?:',

      // Address or hostname with optional port:
      [
        '(?:',
        // IPv6, IPv4, or hostname
        '(?<address>\\[[0-9a-f:]*\\]|[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+|(?:[a-z][a-z0-9\\.]*))',
        // Optional port
        '(?::(?<port1>\\d+))?',
        ')',
      ],

      '|',

      // Simple port:
      [
        '(?:',
        ':?', // optional ':' before port, #2063
        '(?<port2>\\d+)?',
        ')',
      ],

      ')',
    ],

    // END = argument
    ')?',
  ]
    .flat(Infinity)
    .join('');

  return new RegExp(parts, 'i');
});

/*
 * Analyse the given command line arguments and extract debug port and protocol from it.
 */
export function analyseArguments(args: string) {
  const DEBUG_PORT_PATTERN = /--inspect-port=(\d+)/;

  let address: string | undefined;
  let port: number | undefined;

  // match --inspect, --inspect=1234, --inspect-brk, --inspect-brk=1234
  let matches = DEBUG_FLAGS_PATTERN().exec(args);
  if (matches?.groups) {
    const portStr = matches.groups.port1 || matches.groups.port2;
    port = portStr ? Number(portStr) : 9229;
    address = matches.groups.address ?? '127.0.0.1';
  }

  // a --inspect-port=1234 overrides the port
  matches = DEBUG_PORT_PATTERN.exec(args);
  if (matches && matches.length === 2) {
    address ||= '127.0.0.1';
    port = parseInt(matches[1]);
  }

  return { address, port };
}

const NODE_PROCESS_PATTERN = /^(?:node|iojs)(?:$|\b)/i;

/**
 * Gets the name and debug port that the attach picker shows for a process, or
 * undefined if the picker hides it. It lists processes that run Node.js or
 * that were started with a debug port.
 */
export function getPickerEntry(leaf: IProcess) {
  const executableName = basename(leaf.command, '.exe');
  const { port } = analyseArguments(leaf.args);
  return port || NODE_PROCESS_PATTERN.test(executableName) ? { executableName, port } : undefined;
}
