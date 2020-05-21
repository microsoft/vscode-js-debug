/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { LogTag, ILogger } from '../../common/logging';
import { WatchDog } from './watchdogSpawn';
import { NeverCancelled } from '../../common/cancellation';
import { CancellationToken } from 'vscode';
import { processTree, analyseArguments } from '../../ui/processTree/processTree';
import { getWSEndpoint } from '../browser/spawn/endpoints';

interface IProcessTreeNode {
  children: IProcessTreeNode[];
  pid: number;
  ppid: number;
  command: string;
  args: string;
}

export async function watchAllChildren(
  options: {
    pid: number;
    nodePath: string;
    hostname: string;
    ipcAddress: string;
  },
  logger: ILogger,
  cancellation: CancellationToken = NeverCancelled,
): Promise<WatchDog[]> {
  const node = await getProcessTree(options.pid, logger);
  if (!node) {
    return [];
  }

  const todo: Promise<WatchDog | void>[] = [];
  let queue = node.children.slice();
  while (queue.length) {
    const child = queue.pop() as IProcessTreeNode;
    queue = queue.concat(child.children);

    const { port } = analyseArguments(child.args);
    if (!port) {
      continue;
    }

    todo.push(
      getWSEndpoint(`http://${options.hostname}:${port}`, cancellation)
        .then(inspectorURL =>
          WatchDog.attach({
            ipcAddress: options.ipcAddress,
            scriptName: 'Child Process',
            inspectorURL,
            waitForDebugger: true,
            dynamicAttach: true,
            pid: String(child.pid),
            ppid: child.ppid === options.pid ? '0' : String(child.ppid),
          }),
        )
        .catch(err =>
          logger.info(LogTag.Internal, 'Could not spawn WD for child process', {
            err,
            port,
            child,
          }),
        ),
    );
  }

  return (await Promise.all(todo)).filter((wd): wd is WatchDog => !!wd);
}

/**
 * Returns a process tree rooting at the give process ID.
 */
async function getProcessTree(
  rootPid: number,
  logger: ILogger,
): Promise<IProcessTreeNode | undefined> {
  const map = new Map<number, IProcessTreeNode>();

  map.set(0, { children: [], pid: 0, ppid: 0, command: '', args: '' });

  try {
    await processTree.lookup(({ pid, ppid, command, args }) => {
      if (pid !== ppid) {
        map.set(pid, { pid, ppid, command, args, children: [] });
      }
      return map;
    }, null);
  } catch (err) {
    logger.warn(LogTag.Internal, 'Error getting child process tree', err);
    return undefined;
  }

  const values = map.values();
  for (const p of values) {
    const parent = map.get(p.ppid);
    if (parent && parent !== p) {
      parent.children.push(p);
    }
  }

  if (!isNaN(rootPid) && rootPid > 0) {
    return map.get(rootPid);
  }

  return map.get(0);
}
