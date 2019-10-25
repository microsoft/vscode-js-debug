/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

'use strict';

import * as nls from 'vscode-nls';
import * as vscode from 'vscode';
import { basename } from 'path';
import { getProcesses } from './processTree';
import { execSync } from 'child_process';
import { Contributions } from '../common/contributionUtils';
import {
  nodeAttachConfigDefaults,
  INodeAttachConfiguration,
  ResolvingNodeAttachConfiguration,
} from '../configuration';
import { guessWorkingDirectory } from '../nodeDebugConfigurationProvider';
import { mapValues } from '../common/objUtils';

const INSPECTOR_PORT_DEFAULT = 9229;

const localize = nls.loadMessageBundle();

interface ProcessItem extends vscode.QuickPickItem {
  pidOrPort: string; // picker result
  sortKey: number;
}

/**
 * end user action for picking a process and attaching debugger to it
 */
export async function attachProcess() {
  let config: INodeAttachConfiguration = {
    ...nodeAttachConfigDefaults,
    name: 'process',
    processId: `\${command:${Contributions.PickProcessCommand}}`,
  };

  if (!(await resolveProcessId(config))) {
    return;
  }

  const cwd = guessWorkingDirectory(config);
  const assignWorkspaceFolder = (obj: any) =>
    mapValues(obj, value => {
      if (typeof value === 'string') {
        return value.replace('${workspaceFolder}', cwd);
      }

      if (value && typeof value === 'object') {
        return assignWorkspaceFolder(value);
      }

      return value;
    });

  config = assignWorkspaceFolder(config);
  return vscode.debug.startDebugging(undefined, config);
}

/**
 * Resolves the requested process ID, and updates the config object
 * appropriately. Returns true if the configuration was updated, false
 * if it was cancelled.
 */
export async function resolveProcessId(config: ResolvingNodeAttachConfiguration): Promise<boolean> {
  // we resolve Process Picker early (before VS Code) so that we can probe the process for its protocol
  let processId = config.processId && config.processId.trim();
  if (
    !processId ||
    processId === '${command:PickProcess}' ||
    processId === `\${command:${Contributions.PickProcessCommand}}`
  ) {
    const result = await pickProcess(true); // ask for pids and ports!
    if (!result) {
      return false; // UI dismissed (cancelled)
    }

    processId = result;
  }

  const matches = /^(inspector)?([0-9]+)(inspector)?([0-9]+)?$/.exec(processId);
  if (!matches || matches.length !== 5) {
    throw new Error(
      localize(
        'process.id.error',
        "Attach to process: '{0}' doesn't look like a process id.",
        processId,
      ),
    );
  }

  if (matches[2] && matches[3] && matches[4]) {
    // process id and protocol and port
    const pid = Number(matches[2]);
    putPidInDebugMode(pid);

    // debug port
    config.port = Number(matches[4]);
    delete config.processId;
  } else {
    // protocol and port
    if (matches[1]) {
      // debug port
      config.port = Number(matches[2]);
      delete config.processId;
    } else {
      // process id
      const pid = Number(matches[2]);
      putPidInDebugMode(pid);

      // processID is handled, so turn this config into a normal port attach configuration
      delete config.processId;
      config.port = INSPECTOR_PORT_DEFAULT;
    }
  }

  return true;
}

/**
 * Process picker command (for launch config variable)
 * Returns as a string with these formats:
 * - "12345": process id
 * - "inspector12345": port number and inspector protocol
 * - "legacy12345": port number and legacy protocol
 * - null: abort launch silently
 */
export async function pickProcess(ports: boolean = false): Promise<string | null> {
  try {
    const items = await listProcesses();
    let options: vscode.QuickPickOptions = {
      placeHolder: localize('pickNodeProcess', 'Pick the node.js process to attach to'),
      matchOnDescription: true,
      matchOnDetail: true,
    };
    const item = await vscode.window.showQuickPick(items, options);
    return item ? item.pidOrPort : null;
  } catch (err) {
    await vscode.window.showErrorMessage(
      localize('process.picker.error', 'Process picker failed ({0})', err.message),
      { modal: true },
    );
    return null;
  }
}

//---- private

async function listProcesses(): Promise<ProcessItem[]> {
  const nodeProcessPattern = /^(?:node|iojs)$/i;
  let seq = 0; // default sort key

  const items = await getProcesses<ProcessItem[]>(({ pid, command, args, date }, acc) => {
    if (process.platform === 'win32' && command.indexOf('\\??\\') === 0) {
      // remove leading device specifier
      command = command.replace('\\??\\', '');
    }

    const executableName = basename(command, '.exe');
    const { port } = analyseArguments(args);

    let description: string | void;
    let pidOrPort: string;
    if (port) {
      description = localize(
        'process.id.port.signal',
        'process id: {0}, debug port: {1} ({2})',
        pid,
        port,
        'SIGUSR1',
      );
      pidOrPort = `${pid}${port}`;
    } else if (nodeProcessPattern.test(executableName)) {
      description = localize('process.id.signal', 'process id: {0} ({1})', pid, 'SIGUSR1');
      pidOrPort = pid.toString();
    } else {
      return acc;
    }

    return [
      ...acc,
      {
        // render data
        label: executableName,
        description: args,
        detail: description,
        // picker result
        pidOrPort: pidOrPort,
        // sort key
        sortKey: date ? date : seq++,
      },
    ];
  }, []);

  return items.sort((a, b) => b.sortKey - a.sortKey); // sort items by process id, newest first
}

function putPidInDebugMode(pid: number): void {
  try {
    if (process.platform === 'win32') {
      // regular node has an undocumented API function for forcing another node process into debug mode.
      // 		(<any>process)._debugProcess(pid);
      // But since we are running on Electron's node, process._debugProcess doesn't work (for unknown reasons).
      // So we use a regular node instead:
      const command = `node -e process._debugProcess(${pid})`;
      execSync(command);
    } else {
      process.kill(pid, 'SIGUSR1');
    }
  } catch (e) {
    throw new Error(
      localize(
        'cannot.enable.debug.mode.error',
        "Attach to process: cannot enable debug mode for process '{0}' ({1}).",
        pid,
        e,
      ),
    );
  }
}

/*
 * analyse the given command line arguments and extract debug port and protocol from it.
 */
export function analyseArguments(args: string) {
  const DEBUG_FLAGS_PATTERN = /--inspect(-brk)?(=((\[[0-9a-fA-F:]*\]|[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+|[a-zA-Z0-9\.]*):)?(\d+))?/;
  const DEBUG_PORT_PATTERN = /--inspect-port=(\d+)/;

  let address: string | undefined;
  let port: number | undefined;

  // match --inspect, --inspect=1234, --inspect-brk, --inspect-brk=1234
  let matches = DEBUG_FLAGS_PATTERN.exec(args);
  if (matches && matches.length >= 2) {
    if (matches.length >= 6 && matches[5]) {
      address = matches[5];
    }
    if (matches.length >= 7 && matches[6]) {
      port = parseInt(matches[6]);
    }
  }

  // a --inspect-port=1234 overrides the port
  matches = DEBUG_PORT_PATTERN.exec(args);
  if (matches && matches.length === 3) {
    port = parseInt(matches[2]);
  }

  return { address, port };
}
