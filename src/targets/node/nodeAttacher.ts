/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { AnyLaunchConfiguration, INodeAttachConfiguration } from '../../configuration';
import { Contributions } from '../../common/contributionUtils';
import { getWSEndpoint } from '../browser/launcher';
import { spawnWatchdog } from './watchdogSpawn';
import { NodeLauncherBase, IRunData } from './nodeLauncherBase';
import { findInPath } from '../../common/pathUtils';
import { Socket } from 'net';
import { SubprocessProgram } from './program';

/**
 * Attaches to ongoing Node processes. This works pretty similar to the
 * existing Node launcher, except with how we attach to the entry point:
 * we don't have the bootloader in there, so we manually attach and enable
 * the debugger, then evaluate and set the environment variables so that
 * child processes operate just like those we boot with the NodeLauncher.
 */
export class NodeAttacher extends NodeLauncherBase<INodeAttachConfiguration> {
  /**
   * @inheritdoc
   */
  protected resolveParams(params: AnyLaunchConfiguration): INodeAttachConfiguration | undefined {
    return params.type === Contributions.NodeDebugType && params.request === 'attach'
      ? params
      : undefined;
  }

  /**
   * @inheritdoc
   */
  protected async launchProgram(runData: IRunData<INodeAttachConfiguration>): Promise<void> {
    const wd = spawnWatchdog(findInPath('node', process.env) || 'node', {
      ipcAddress: runData.serverAddress,
      scriptName: 'Remote Process',
      inspectorURL: await getWSEndpoint(`http://${runData.params.address}:${runData.params.port}`),
      waitForDebugger: true,
      dynamicAttach: true,
    });

    const program = (this.program = new SubprocessProgram(wd));
    this.program.stopped.then(result => {
      if (program === this.program) {
        this.onProgramTerminated(result);
      }
    });
  }
}
