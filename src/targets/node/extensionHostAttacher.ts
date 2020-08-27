/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { injectable } from 'inversify';
import { getSourceSuffix } from '../../adapter/templates';
import Cdp from '../../cdp/api';
import { DebugType } from '../../common/contributionUtils';
import { LogTag } from '../../common/logging';
import { Semver } from '../../common/semver';
import { AnyLaunchConfiguration, IExtensionHostAttachConfiguration } from '../../configuration';
import { retryGetWSEndpoint } from '../browser/spawn/endpoints';
import { NodeAttacherBase } from './nodeAttacherBase';
import { NodeBinary } from './nodeBinaryProvider';
import { IRunData } from './nodeLauncherBase';
import { TerminalProcess, WatchDogProgram } from './program';
import { WatchDog } from './watchdogSpawn';

/**
 * Attaches to an instance of VS Code for extension debugging.
 */
@injectable()
export class ExtensionHostAttacher extends NodeAttacherBase<IExtensionHostAttachConfiguration> {
  protected restarting = false;

  /**
   * @inheritdoc
   */
  public async restart() {
    this.restarting = true;
    this.onProgramTerminated({ code: 0, killed: true, restart: true });
    this.program?.stop();
  }

  /**
   * @inheritdoc
   */
  protected resolveParams(
    params: AnyLaunchConfiguration,
  ): IExtensionHostAttachConfiguration | undefined {
    return params.type === DebugType.ExtensionHost && params.request === 'attach'
      ? params
      : undefined;
  }

  /**
   * @inheritdoc
   */
  protected async launchProgram(
    runData: IRunData<IExtensionHostAttachConfiguration>,
  ): Promise<void> {
    const inspectorURL = await retryGetWSEndpoint(
      `http://localhost:${runData.params.port}`,
      runData.context.cancellationToken,
      this.logger,
    );

    const wd = await WatchDog.attach({
      ipcAddress: runData.serverAddress,
      scriptName: 'Extension Host',
      inspectorURL,
      waitForDebugger: true,
      dynamicAttach: true,
    });

    const program = (this.program = new WatchDogProgram(wd));
    this.program.stopped.then(result => {
      if (program === this.program) {
        this.onProgramTerminated(result);
      }
    });
  }

  /**
   * @override
   */
  protected createLifecycle(
    cdp: Cdp.Api,
    run: IRunData<IExtensionHostAttachConfiguration>,
    target: Cdp.Target.TargetInfo,
  ) {
    return target.openerId ? {} : { initialized: () => this.onFirstInitialize(cdp, run) };
  }

  /**
   * Called the first time, for each program, we get an attachment. Can
   * return disposables to clean up when the run finishes.
   */
  protected async onFirstInitialize(
    cdp: Cdp.Api,
    run: IRunData<IExtensionHostAttachConfiguration>,
  ) {
    this.setEnvironmentVariables(cdp, run);
    const telemetry = await this.gatherTelemetryFromCdp(cdp, run);

    // Monitor the process ID we read from the telemetry. Once the VS Code
    // process stops, stop our Watchdog, and vise versa.
    const watchdog = this.program;
    if (telemetry && watchdog) {
      const code = new TerminalProcess({ processId: telemetry.processId }, this.logger);
      code.stopped.then(() => watchdog.stop());
      watchdog.stopped.then(() => {
        if (!this.restarting) {
          code.stop();
        }
      });
    }
  }

  private async setEnvironmentVariables(
    cdp: Cdp.Api,
    run: IRunData<IExtensionHostAttachConfiguration>,
  ) {
    if (!run.params.autoAttachChildProcesses) {
      return;
    }

    const vars = await this.resolveEnvironment(
      run,
      new NodeBinary('node', Semver.parse(process.versions.node)),
      { ppid: 0 },
    );

    const result = await cdp.Runtime.evaluate({
      contextId: 1,
      returnByValue: true,
      expression:
        `Object.assign(process.env, ${JSON.stringify(vars.defined())})` + getSourceSuffix(),
    });

    if (!result) {
      this.logger.error(LogTag.RuntimeTarget, 'Undefined result setting child environment vars');
    } else if (result.exceptionDetails) {
      this.logger.error(
        LogTag.RuntimeTarget,
        'Error setting child environment vars',
        result.exceptionDetails,
      );
    }
  }
}
