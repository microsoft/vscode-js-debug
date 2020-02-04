/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { execSync } from 'child_process';
import { basename } from 'path';
import * as vscode from 'vscode';
import * as nls from 'vscode-nls';
import { Contributions } from '../common/contributionUtils';
import {
  INodeAttachConfiguration,
  nodeAttachConfigDefaults,
  ResolvingNodeAttachConfiguration,
} from '../configuration';
import { processTree, analyseArguments } from './processTree/processTree';

const INSPECTOR_PORT_DEFAULT = 9229;

const localize = nls.loadMessageBundle();

interface IProcessItem extends vscode.QuickPickItem {
  pidAndPort: string; // picker result
  sortKey: number;
}

/**
 * end user action for picking a process and attaching debugger to it
 */
export async function attachProcess() {
  const config: INodeAttachConfiguration = {
    ...nodeAttachConfigDefaults,
    name: 'process',
    processId: `\${command:${Contributions.PickProcessCommand}}`,
  };

  if (!(await resolveProcessId(config))) {
    return;
  }

  await vscode.debug.startDebugging(
    vscode.workspace.getWorkspaceFolder(vscode.Uri.file(config.cwd)),
    config,
  );
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
    const result = await pickProcess(); // ask for pids and ports!
    if (!result) {
      return false; // UI dismissed (cancelled)
    }

    processId = result;
  }

  const result = decodePidAndPort(processId);
  if (isNaN(result.pid)) {
    throw new Error(
      localize(
        'process.id.error',
        "Attach to process: '{0}' doesn't look like a process id.",
        processId,
      ),
    );
  }

  if (!result.port) {
    putPidInDebugMode(result.pid);
  }

  config.port = result.port || INSPECTOR_PORT_DEFAULT;
  delete config.processId;

  if (vscode.workspace.workspaceFolders?.length === 1) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    config.cwd = vscode.workspace.workspaceFolders![0].uri.fsPath;
  } else if (processId) {
    const inferredWd = await processTree.getWorkingDirectory(result.pid);
    if (inferredWd) {
      config.cwd = await processTree.getWorkingDirectory(result.pid);
    }
  }

  return true;
}

/**
 * Process picker command (for launch config variable). Returns a string in
 * the format `pid:port`, where port is optional.
 */
export async function pickProcess(): Promise<string | null> {
  try {
    const items = await listProcesses();
    const options: vscode.QuickPickOptions = {
      placeHolder: localize('pickNodeProcess', 'Pick the node.js process to attach to'),
      matchOnDescription: true,
      matchOnDetail: true,
    };
    const item = await vscode.window.showQuickPick(items, options);
    return item ? item.pidAndPort : null;
  } catch (err) {
    await vscode.window.showErrorMessage(
      localize('process.picker.error', 'Process picker failed ({0})', err.message),
      { modal: true },
    );
    return null;
  }
}

//---- private

const encodePidAndPort = (processId: number, port?: number) => `${processId}:${port ?? ''}`;
const decodePidAndPort = (encoded: string) => {
  const [pid, port] = encoded.split(':');
  return { pid: Number(pid), port: port ? Number(port) : undefined };
};

async function listProcesses(): Promise<IProcessItem[]> {
  const nodeProcessPattern = /^(?:node|iojs)$/i;
  let seq = 0; // default sort key

  const items = await processTree.lookup<IProcessItem[]>((leaf, acc) => {
    if (process.platform === 'win32' && leaf.command.indexOf('\\??\\') === 0) {
      // remove leading device specifier
      leaf.command = leaf.command.replace('\\??\\', '');
    }

    const executableName = basename(leaf.command, '.exe');
    const { port } = analyseArguments(leaf.args);
    if (!port && !nodeProcessPattern.test(executableName)) {
      return acc;
    }

    return [
      ...acc,
      {
        label: executableName,
        description: leaf.args,
        pidAndPort: encodePidAndPort(leaf.pid, port),
        sortKey: leaf.date ? leaf.date : seq++,
        detail: port
          ? localize(
              'process.id.port.signal',
              'process id: {0}, debug port: {1} ({2})',
              leaf.pid,
              port,
              'SIGUSR1',
            )
          : localize('process.id.signal', 'process id: {0} ({1})', leaf.pid, 'SIGUSR1'),
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
