/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { execSync } from 'child_process';
import { basename } from 'path';
import * as vscode from 'vscode';
import * as nls from 'vscode-nls';
import {
  INodeAttachConfiguration,
  nodeAttachConfigDefaults,
  ResolvingNodeAttachConfiguration,
} from '../configuration';
import { processTree, analyseArguments } from './processTree/processTree';
import { readConfig, Configuration } from '../common/contributionUtils';
import { nearestDirectoryContaining } from '../common/urlUtils';
import { isSubdirectoryOf } from '../common/pathUtils';

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
  // We pick here, rather than just putting the command as the process ID, so
  // that the cwd is set correctly in multi-root workspaces.
  const processId = await pickProcess();
  if (!processId) {
    return;
  }

  const userDefaults = readConfig(vscode.workspace, Configuration.PickAndAttachDebugOptions);

  const config: INodeAttachConfiguration = {
    ...nodeAttachConfigDefaults,
    ...userDefaults,
    name: 'process',
    processId,
  };

  await resolveProcessId(config, true);
  await vscode.debug.startDebugging(
    config.cwd ? vscode.workspace.getWorkspaceFolder(vscode.Uri.file(config.cwd)) : undefined,
    config,
  );
}

/**
 * Resolves the requested process ID, and updates the config object
 * appropriately. Returns true if the configuration was updated, false
 * if it was cancelled.
 */
export async function resolveProcessId(config: ResolvingNodeAttachConfiguration, setCwd = false) {
  // we resolve Process Picker early (before VS Code) so that we can probe the process for its protocol
  const processId = config.processId?.trim();
  const result = processId && decodePidAndPort(processId);
  if (!result || isNaN(result.pid)) {
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

  if (setCwd) {
    const inferredWd = await inferWorkingDirectory(result.pid);
    if (inferredWd) {
      config.cwd = inferredWd;
    }
  }
}

async function inferWorkingDirectory(processId?: number) {
  const inferredWd = processId && (await processTree.getWorkingDirectory(processId));

  // If we couldn't infer the working directory, just use the first workspace folder
  if (!inferredWd) {
    return vscode.workspace.workspaceFolders?.[0].uri.fsPath;
  }

  const packageRoot = await nearestDirectoryContaining(inferredWd, 'package.json');
  if (!packageRoot) {
    return inferredWd;
  }

  // Find the working directory package root. If the original inferred working
  // directory was inside a workspace folder, don't go past that.
  const parentWorkspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(inferredWd));
  return !parentWorkspaceFolder || isSubdirectoryOf(parentWorkspaceFolder.uri.fsPath, packageRoot)
    ? packageRoot
    : parentWorkspaceFolder.uri.fsPath;
}

/**
 * Process picker command (for launch config variable). Returns a string in
 * the format `pid:port`, where port is optional.
 */
export async function pickProcess(): Promise<string | null> {
  try {
    const item = await listProcesses();
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

async function listProcesses(): Promise<IProcessItem> {
  const nodeProcessPattern = /^(?:node|iojs)$/i;
  let seq = 0; // default sort key

  const quickPick = await vscode.window.createQuickPick<IProcessItem>();
  quickPick.placeholder = localize('pickNodeProcess', 'Pick the node.js process to attach to');
  quickPick.matchOnDescription = true;
  quickPick.matchOnDetail = true;
  quickPick.busy = true;
  quickPick.show();

  let hasPicked = false;
  const itemPromise = new Promise<IProcessItem>(resolve => {
    quickPick.onDidAccept(() => resolve(quickPick.selectedItems[0]));
    quickPick.onDidHide(() => resolve(undefined));
  });

  processTree
    .lookup<IProcessItem[]>((leaf, acc) => {
      if (hasPicked) {
        return acc;
      }

      if (process.platform === 'win32' && leaf.command.indexOf('\\??\\') === 0) {
        // remove leading device specifier
        leaf.command = leaf.command.replace('\\??\\', '');
      }

      const executableName = basename(leaf.command, '.exe');
      const { port } = analyseArguments(leaf.args);
      if (!port && !nodeProcessPattern.test(executableName)) {
        return acc;
      }

      const newItem = {
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
      };

      const index = acc.findIndex(item => item.sortKey < newItem.sortKey);
      acc.splice(index === -1 ? acc.length : index, 0, newItem);
      quickPick.items = acc;
      return acc;
    }, [])
    .then(() => (quickPick.busy = false));

  const item = await itemPromise;
  hasPicked = true;
  quickPick.dispose();
  return item;
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
