/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { injectable } from 'inversify';
import { getSourceSuffix } from '../../adapter/templates';
import Cdp from '../../cdp/api';
import { DebugType } from '../../common/contributionUtils';
import { ILogger, LogTag } from '../../common/logging';
import { delay } from '../../common/promiseUtil';
import { Semver } from '../../common/semver';
import {
  AnyLaunchConfiguration,
  IExtensionHostAttachConfiguration,
  KillBehavior,
} from '../../configuration';
import { retryGetNodeEndpoint } from '../browser/spawn/endpoints';
import { killTree } from './killTree';
import { NodeAttacherBase } from './nodeAttacherBase';
import { NodeBinary } from './nodeBinaryProvider';
import { IRunData } from './nodeLauncherBase';
import { TerminalProcess, WatchDogProgram } from './program';
import { WatchDog } from './watchdogSpawn';

/**
 * Special program for the EH because even this it's an "attach" we should
 * still kill it at the end. See vscode#126911
 */
class ExtensionHostProgram extends WatchDogProgram {
  constructor(wd: WatchDog, private readonly logger: ILogger) {
    super(wd);

    this.stopped.then(() => {
      if (this.telemetry) {
        killTree(this.telemetry.processId, this.logger, KillBehavior.Polite);
      }
    });
  }
}

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
    const inspectorURL = await retryGetNodeEndpoint(
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

    const program = (this.program = new ExtensionHostProgram(wd, this.logger));
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
    return target.openerId ? {} : { initialized: () => this.onFirstInitialize(cdp, run, target) };
  }

  /**
   * Called the first time, for each program, we get an attachment. Can
   * return disposables to clean up when the run finishes.
   */
  protected async onFirstInitialize(
    cdp: Cdp.Api,
    run: IRunData<IExtensionHostAttachConfiguration>,
    target: Cdp.Target.TargetInfo,
  ) {
    this.setEnvironmentVariables(cdp, run, target.targetId);
    const telemetry = await this.gatherTelemetryFromCdp(cdp, run);

    // Monitor the process ID we read from the telemetry. Once the VS Code
    // process stops, stop our Watchdog, and vise versa.
    const watchdog = this.program;
    if (telemetry && watchdog) {
      const code = new TerminalProcess(
        { processId: telemetry.processId },
        this.logger,
        KillBehavior.Forceful,
      );
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
    targetId: string,
  ) {
    if (!run.params.autoAttachChildProcesses) {
      return;
    }

    const vars = await this.resolveEnvironment(
      run,
      new NodeBinary('node', Semver.parse(process.versions.node)),
      { openerId: targetId },
    );

    for (let retries = 0; retries < 200; retries++) {
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
      } else {
        return;
      }

      await delay(50);
    }
  }
}
