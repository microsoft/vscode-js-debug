/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { INodeLaunchConfiguration, AnyLaunchConfiguration } from '../../configuration';
import { DebugType } from '../../common/contributionUtils';
import { IProgramLauncher } from './processLauncher';
import { CallbackFile } from './callback-file';
import { RestartPolicyFactory, IRestartPolicy } from './restartPolicy';
import { delay } from '../../common/promiseUtil';
import { NodeLauncherBase, IProcessTelemetry, IRunData } from './nodeLauncherBase';
import { INodeTargetLifecycleHooks } from './nodeTarget';
import { absolutePathToFileUrl, urlToRegex } from '../../common/urlUtils';
import { resolve } from 'path';
import Cdp from '../../cdp/api';
import { NodePathProvider, INodePathProvider } from './nodePathProvider';
import { exists } from '../../common/fsUtils';
import { LogTag, ILogger } from '../../common/logging';
import { fixInspectFlags } from '../../ui/configurationUtils';
import { injectable, inject, multiInject } from 'inversify';

/**
 * Tries to get the "program" entrypoint from the config. It a program
 * is explicitly provided, it grabs that, otherwise it looks for the first
 * existent path within the launch arguments.
 */
const tryGetProgramFromArgs = async (config: INodeLaunchConfiguration) => {
  if (typeof config.stopOnEntry === 'string') {
    return resolve(config.cwd, config.stopOnEntry);
  }

  if (config.program) {
    return resolve(config.cwd, config.program);
  }

  for (const arg of config.args) {
    if (arg.startsWith('-')) {
      // looks like a flag
      continue;
    }

    const candidate = resolve(config.cwd, arg);
    if (await exists(candidate)) {
      return candidate;
    }
  }

  return undefined;
};

@injectable()
export class NodeLauncher extends NodeLauncherBase<INodeLaunchConfiguration> {
  constructor(
    @inject(INodePathProvider) pathProvider: NodePathProvider,
    @inject(ILogger) logger: ILogger,
    @multiInject(IProgramLauncher) private readonly launchers: ReadonlyArray<IProgramLauncher>,
    @inject(RestartPolicyFactory) private readonly restarters: RestartPolicyFactory,
  ) {
    super(pathProvider, logger);
  }

  /**
   * @inheritdoc
   */
  protected resolveParams(params: AnyLaunchConfiguration): INodeLaunchConfiguration | undefined {
    let config: INodeLaunchConfiguration | undefined;
    if (params.type === DebugType.Node && params.request === 'launch') {
      config = { ...params };
    } else if (params.type === DebugType.Chrome && params.server && 'program' in params.server) {
      config = { ...params.server };
    }

    if (!config) {
      return undefined;
    }

    fixInspectFlags(config);
    return config;
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

        if (result.killed || result.code === 0) {
          this.onProgramTerminated(result);
          return;
        }

        const nextRestart = restartPolicy.next();
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

    return doLaunch(this.restarters.create(runData.params.restart));
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
        if (!run.params.stopOnEntry) {
          return;
        }

        // This is not an ideal stop-on-entry setup. The previous debug adapter
        // had life easier because it could ask the Node process to stop from
        // the get-go, but in our scenario the bootloader is the first thing
        // which is run and something we don't want to break in. We just
        // do our best to find the entrypoint from the run params.
        const program = await tryGetProgramFromArgs(run.params);
        if (!program) {
          this.logger.warn(LogTag.Runtime, 'Could not resolve program entrypointfrom args');
          return;
        }

        const breakpoint = await cdp.Debugger.setBreakpointByUrl({
          urlRegex: urlToRegex(absolutePathToFileUrl(program) ?? program),
          lineNumber: 0,
          columnNumber: 0,
        });

        return breakpoint?.breakpointId;
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
