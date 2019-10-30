// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { INodeLaunchConfiguration, AnyLaunchConfiguration } from '../../configuration';
import { Contributions } from '../../common/contributionUtils';
import { IProgramLauncher } from './processLauncher';
import { CallbackFile } from './callback-file';
import { RestartPolicyFactory, IRestartPolicy } from './restartPolicy';
import { delay } from '../../common/promiseUtil';
import { NodeLauncherBase, IProcessTelemetry, IRunData } from './nodeLauncherBase';
import { RawTelemetryReporterToDap, RawTelemetryReporter } from '../../telemetry/telemetryReporter';

export class NodeLauncher extends NodeLauncherBase<INodeLaunchConfiguration> {
  constructor(
    private readonly launchers: ReadonlyArray<IProgramLauncher>,
    private readonly restarters = new RestartPolicyFactory(),
  ) {
    super();
  }

  /**
   * @inheritdoc
   */
  protected resolveParams(params: AnyLaunchConfiguration): INodeLaunchConfiguration | undefined {
    if (params.type === Contributions.NodeDebugType && params.request === 'launch') {
      return params;
    }

    if (
      params.type === Contributions.ChromeDebugType &&
      params.request === 'launch' &&
      params.server
    ) {
      return params.server;
    }

    return undefined;
  }

  /**
   * Launches the program.
   */
  protected async launchProgram(runData: IRunData<INodeLaunchConfiguration>): Promise<void> {
    const doLaunch = async (restartPolicy: IRestartPolicy) => {
      // Close any existing program. We intentionally don't wait for stop() to
      // finish, since doing so will shut down the server.
      if (this.program) {
        this.program.stop(); // intentionally not awaited on
      }

      const callbackFile = new CallbackFile<IProcessTelemetry>();
      const options: INodeLaunchConfiguration = {
        ...runData.params,
        env: this.resolveEnvironment(runData, callbackFile.path).value,
      };
      const launcher = this.launchers.find(l => l.canLaunch(options));
      if (!launcher) {
        throw new Error('Cannot find an appropriate launcher for the given set of options');
      }

      const program = (this.program = await launcher.launchProgram(options, runData.context));

      // Once the program stops, dispose of the file. If we started a new program
      // in the meantime, don't do anything. Otherwise, restart if we need to,
      // and if we don't then shut down the server and indicate that we terminated.
      program.stopped.then(async result => {
        callbackFile.dispose();

        if (this.program !== program) {
          return;
        }

        const nextRestart = restartPolicy.next(result);
        if (!nextRestart) {
          this.onProgramTerminated(result);
          return;
        }

        await delay(nextRestart.delay);
        if (this.program === program) {
          doLaunch(nextRestart);
        }
      });

      // Read the callback file, and signal the running program when we read
      // data. read() retur
      callbackFile.read().then(data => {
        if (data) {
          program.gotTelemetery(data);
        }
      });
    };

    doLaunch(this.restarters.create(runData.params));
  }
}
