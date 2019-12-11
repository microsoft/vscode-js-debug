/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { INodeLaunchConfiguration, AnyLaunchConfiguration } from '../../configuration';
import { Contributions } from '../../common/contributionUtils';
import { IProgramLauncher } from './processLauncher';
import { CallbackFile } from './callback-file';
import { RestartPolicyFactory, IRestartPolicy } from './restartPolicy';
import { delay } from '../../common/promiseUtil';
import { NodeLauncherBase, IProcessTelemetry, IRunData } from './nodeLauncherBase';
import { INodeTargetLifecycleHooks } from './nodeTarget';
import { absolutePathToFileUrl } from '../../common/urlUtils';
import { resolve } from 'path';
import Cdp from '../../cdp/api';
import { NodePathProvider } from './nodePathProvider';

export class NodeLauncher extends NodeLauncherBase<INodeLaunchConfiguration> {
  constructor(
    pathProvider: NodePathProvider,
    private readonly launchers: ReadonlyArray<IProgramLauncher>,
    private readonly restarters = new RestartPolicyFactory(),
  ) {
    super(pathProvider);
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
      params.server &&
      'program' in params.server
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

      const binary = await this.resolveNodePath(
        runData.params,
        runData.params.runtimeExecutable || undefined,
      );
      const program = (this.program = await launcher.launchProgram(
        binary,
        options,
        runData.context,
      ));

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

    return doLaunch(this.restarters.create(runData.params));
  }

  /**
   * @inheritdoc
   */
  protected createLifecycle(
    cdp: Cdp.Api,
    run: IRunData<INodeLaunchConfiguration>,
    { targetId }: Cdp.Target.TargetInfo,
  ): INodeTargetLifecycleHooks {
    return {
      initialized: async () => {
        if (run.params.stopOnEntry) {
          const params = {
            url: absolutePathToFileUrl(resolve(run.params.cwd, run.params.program)),
            lineNumber: 0,
            columnNumber: 0,
          };

          await cdp.Debugger.setBreakpointByUrl(params);
        }
      },
      close: () => {
        const processId = Number(targetId);
        if (processId > 0) {
          try {
            process.kill(processId);
          } catch (e) {
            // ignored
          }
        }
      },
    };
  }
}
