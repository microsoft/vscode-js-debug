/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { AnyLaunchConfiguration, IExtensionHostConfiguration } from '../../configuration';
import { Contributions } from '../../common/contributionUtils';
import { IRunData } from './nodeLauncherBase';
import { SubprocessProgram, TerminalProcess } from './program';
import { retryGetWSEndpoint } from '../browser/launcher';
import { spawnWatchdog } from './watchdogSpawn';
import Cdp from '../../cdp/api';
import { IDisposable } from '../../common/disposable';
import { NodeAttacherBase } from './nodeAttacherBase';

/**
 * Attaches to an instance of VS Code for extension debugging.
 */
export class ExtensionHostAttacher extends NodeAttacherBase<IExtensionHostConfiguration> {
  protected restarting = false;

  /**
   * @inheritdoc
   */
  public async restart() {
    this.restarting = true;
    this.onProgramTerminated({ code: 0, killed: true, restart: true });

    if (this.program) {
      this.program.stop();
    }
  }

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
    const inspectorUrl = await retryGetWSEndpoint(
      `http://localhost:${runData.params.port}`,
      runData.context.cancellationToken,
    );

    const wd = spawnWatchdog(await this.resolveNodePath(runData.params), {
      ipcAddress: runData.serverAddress,
      scriptName: 'Extension Host',
      inspectorURL: inspectorUrl!,
      waitForDebugger: true,
      dynamicAttach: true,
    });

    const program = (this.program = new SubprocessProgram(wd, this.logger));
    this.program.stopped.then(result => {
      if (program === this.program) {
        this.onProgramTerminated(result);
      }
    });
  }

  /**
   * Called the first time, for each program, we get an attachment. Can
   * return disposables to clean up when the run finishes.
   */
  protected async onFirstInitialize(
    cdp: Cdp.Api,
    run: IRunData<IExtensionHostConfiguration>,
  ): Promise<ReadonlyArray<IDisposable>> {
    const telemetry = await this.gatherTelemetry(cdp, run);

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

    return [];
  }
}
