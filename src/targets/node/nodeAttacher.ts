/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { AnyLaunchConfiguration, INodeAttachConfiguration } from '../../configuration';
import { Contributions } from '../../common/contributionUtils';
import { getWSEndpoint } from '../browser/launcher';
import { spawnWatchdog } from './watchdogSpawn';
import { NodeLauncherBase, IRunData } from './nodeLauncherBase';
import { findInPath } from '../../common/pathUtils';
import { SubprocessProgram } from './program';
import Cdp from '../../cdp/api';
import { isLoopback } from '../../common/urlUtils';
import { INodeTargetLifecycleHooks } from './nodeTarget';
import { LeaseFile } from './lease-file';

/**
 * Attaches to ongoing Node processes. This works pretty similar to the
 * existing Node launcher, except with how we attach to the entry point:
 * we don't have the bootloader in there, so we manually attach and enable
 * the debugger, then evaluate and set the environment variables so that
 * child processes operate just like those we boot with the NodeLauncher.
 */
export class NodeAttacher extends NodeLauncherBase<INodeAttachConfiguration> {
  /**
   * Tracker for whether we're waiting to break and instrument into the main
   * process. This is used to avoid instrumenting unecessarily into subsequent
   * children.
   */
  private capturedBreaker = false;

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

    this.capturedBreaker = false;
  }

  /**
   * @inheritdoc
   */
  protected createLifecycle(
    cdp: Cdp.Api,
    run: IRunData<INodeAttachConfiguration>,
  ): INodeTargetLifecycleHooks {
    if (this.capturedBreaker) {
      return {};
    }

    // We use a lease file to indicate to the process that the debugger is
    // still running. This is needed because once we attach, we set the
    // NODE_OPTIONS for the process, forever. We can try to unset this on
    // close, but this isn't reliable as it's always possible
    const leaseFile = new LeaseFile();

    let hitFirstBreakpoint = false;
    this.capturedBreaker = true;

    return {
      initialized: async () => {
        await cdp.Debugger.pause({});
      },
      paused: async (_target, ev) => {
        if (hitFirstBreakpoint) {
          return false;
        }

        hitFirstBreakpoint = true;
        await Promise.all([
          this.gatherTelemetry(cdp),
          this.setEnvironmentVariables(cdp, run, leaseFile.path),
        ]);
        await cdp.Debugger.resume({});

        return true;
      },
      close: async () => {
        leaseFile.dispose();
      },
    };
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
      // todo: logger.log("Cannot attach to children of remote process")
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

    if (!result || result.exceptionDetails) {
      // todo: log error assigning vars
    }
  }

  private async gatherTelemetry(cdp: Cdp.Api) {
    const telemetry = await cdp.Runtime.evaluate({
      contextId: 1,
      returnByValue: true,
      expression: `({ processId: process.pid, nodeVersion: process.version, architecture: process.arch })`,
    });

    if (!this.program) {
      return; // shut down
    }

    if (!telemetry || telemetry.exceptionDetails) {
      // todo: log error getting telemetry
      return;
    }

    this.program.gotTelemetery(telemetry.result.value);
  }
}
