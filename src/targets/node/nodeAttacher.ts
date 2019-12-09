/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { AnyLaunchConfiguration, INodeAttachConfiguration } from '../../configuration';
import { Contributions } from '../../common/contributionUtils';
import { retryGetWSEndpoint } from '../browser/launcher';
import { spawnWatchdog } from './watchdogSpawn';
import { IRunData } from './nodeLauncherBase';
import { SubprocessProgram } from './program';
import Cdp from '../../cdp/api';
import { isLoopback } from '../../common/urlUtils';
import { LeaseFile } from './lease-file';
import { logger } from '../../common/logging/logger';
import { LogTag } from '../../common/logging';
import { NodeAttacherBase } from './nodeAttacherBase';
import { watchAllChildren } from './nodeAttacherCluster';

/**
 * Attaches to ongoing Node processes. This works pretty similar to the
 * existing Node launcher, except with how we attach to the entry point:
 * we don't have the bootloader in there, so we manually attach and enable
 * the debugger, then evaluate and set the environment variables so that
 * child processes operate just like those we boot with the NodeLauncher.
 */
export class NodeAttacher extends NodeAttacherBase<INodeAttachConfiguration> {
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
    const wd = spawnWatchdog(await this.resolveNodePath(runData.params), {
      ipcAddress: runData.serverAddress,
      scriptName: 'Remote Process',
      inspectorURL: await retryGetWSEndpoint(
        `http://${runData.params.address}:${runData.params.port}`,
        runData.context.cancellationToken,
      ),
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

  protected async onFirstInitialize(cdp: Cdp.Api, run: IRunData<INodeAttachConfiguration>) {
    // We use a lease file to indicate to the process that the debugger is
    // still running. This is needed because once we attach, we set the
    // NODE_OPTIONS for the process, forever. We can try to unset this on
    // close, but this isn't reliable as it's always possible
    const leaseFile = new LeaseFile();

    const [telemetry] = await Promise.all([
      this.gatherTelemetry(cdp, run),
      this.setEnvironmentVariables(cdp, run, leaseFile.path),
    ]);

    if (telemetry && run.params.attachSpawnedProcesses) {
      watchAllChildren({
        pid: telemetry.processId,
        nodePath: findInPath('node', process.env) || 'node',
        hostname: run.params.address,
        ipcAddress: run.serverAddress,
      }).catch(err => logger.warn(LogTag.Internal, 'Error watching child processes', { err }));
    }

    return [leaseFile];
  }

  private async setEnvironmentVariables(
    cdp: Cdp.Api,
    run: IRunData<INodeAttachConfiguration>,
    leasePath: string,
  ) {
    if (!run.params.attachSpawnedProcesses) {
      return;
    }

    if (!isLoopback(run.params.address)) {
      logger.warn(LogTag.RuntimeTarget, 'Cannot attach to children of remote process');
      return;
    }

    const vars = this.resolveEnvironment(run).merge({
      NODE_INSPECTOR_PPID: '0',
      NODE_INSPECTOR_REQUIRE_LEASE: leasePath,
    });

    const result = await cdp.Runtime.evaluate({
      contextId: 1,
      returnByValue: true,
      expression: `Object.assign(process.env, ${JSON.stringify(vars.defined())})`,
    });

    if (!result) {
      logger.error(LogTag.RuntimeTarget, 'Undefined result setting child environment vars');
      return;
    }

    if (result.exceptionDetails) {
      logger.error(
        LogTag.RuntimeTarget,
        'Error setting child environment vars',
        result.exceptionDetails,
      );
      return;
    }
  }
}
