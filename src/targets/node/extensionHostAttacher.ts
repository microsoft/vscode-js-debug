/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { AnyLaunchConfiguration, IExtensionHostConfiguration } from '../../configuration';
import { Contributions } from '../../common/contributionUtils';
import { NodeLauncherBase, IRunData } from './nodeLauncherBase';
import { SubprocessProgram } from './program';
import { getWSEndpoint } from '../browser/launcher';
import { delay } from '../../common/promiseUtil';
import { spawnWatchdog } from './watchdogSpawn';
import { findInPath } from '../../common/pathUtils';

/**
 * Attaches to an instance of VS Code for extension debugging.
 */
export class ExtensionHostAttacher extends NodeLauncherBase<IExtensionHostConfiguration> {
  /**
   * @inheritdoc
   */
  protected resolveParams(params: AnyLaunchConfiguration): IExtensionHostConfiguration | undefined {
    return params.type === Contributions.ExtensionHostDebugType && params.request === 'attach'
      ? params
      : undefined;
  }

  /**
   * @inheritdoc
   */
  protected async launchProgram(
    runData: IRunData<IExtensionHostConfiguration>,
  ): Promise<string | void> {
    let inspectorUrl: string | undefined;
    do {
      try {
        inspectorUrl = await getWSEndpoint(
          `http://localhost:${runData.params.port}`,
          runData.context.cancellationToken,
        );
      } catch (e) {
        if (runData.context.cancellationToken.isCancellationRequested) {
          return `Could not connect to extension host: ${e.message}`;
        }

        await delay(200);
      }
    } while (!inspectorUrl);

    const wd = spawnWatchdog(findInPath('node', process.env) || 'node', {
      ipcAddress: runData.serverAddress,
      scriptName: 'Extension Host',
      inspectorURL: inspectorUrl!,
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
