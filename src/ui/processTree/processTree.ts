/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { WindowsProcessTree } from './windowsProcessTree';
import { DarwinProcessTree } from './darwinProcessTree';
import { PosixProcessTree } from './posixProcessTree';

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
export const processTree: IProcessTree =
  process.platform === 'win32'
    ? new WindowsProcessTree()
    : process.platform === 'darwin'
    ? new DarwinProcessTree()
    : new PosixProcessTree();

/*
 * Analyse the given command line arguments and extract debug port and protocol from it.
 */
export function analyseArguments(args: string) {
  const DEBUG_FLAGS_PATTERN = /--inspect(-brk)?(=((\[[0-9a-fA-F:]*\]|[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+|[a-zA-Z0-9\.]*):)?(\d+))?/;
  const DEBUG_PORT_PATTERN = /--inspect-port=(\d+)/;

  let address: string | undefined;
  let port: number | undefined;

  // match --inspect, --inspect=1234, --inspect-brk, --inspect-brk=1234
  let matches = DEBUG_FLAGS_PATTERN.exec(args);
  if (matches && matches.length >= 1) {
    if (matches.length >= 5 && matches[4]) {
      address = matches[4];
    }
    if (matches.length >= 6 && matches[5]) {
      port = parseInt(matches[5]);
    }
  }

  // a --inspect-port=1234 overrides the port
  matches = DEBUG_PORT_PATTERN.exec(args);
  if (matches && matches.length === 2) {
    port = parseInt(matches[1]);
  }

  return { address, port };
}
