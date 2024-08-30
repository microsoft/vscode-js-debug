/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { inject, injectable, multiInject } from 'inversify';
import { extname, resolve } from 'path';
import { IBreakpointsPredictor } from '../../adapter/breakpointPredictor';
import { IPortLeaseTracker } from '../../adapter/portLeaseTracker';
import Cdp from '../../cdp/api';
import { asArray, iteratorFirst } from '../../common/arrayUtils';
import { DebugType } from '../../common/contributionUtils';
import { IFsUtils, LocalFsUtils } from '../../common/fsUtils';
import { ILogger, LogTag } from '../../common/logging';
import { fixDriveLetterAndSlashes } from '../../common/pathUtils';
import { delay } from '../../common/promiseUtil';
import { absolutePathToFileUrl, urlToRegex } from '../../common/urlUtils';
import { AnyLaunchConfiguration, INodeLaunchConfiguration } from '../../configuration';
import { fixInspectFlags } from '../../ui/configurationUtils';
import { retryGetNodeEndpoint } from '../browser/spawn/endpoints';
import { ISourcePathResolverFactory } from '../sourcePathResolverFactory';
import { CallbackFile } from './callback-file';
import {
  Capability,
  getRunScript,
  hideDebugInfoFromConsole,
  INodeBinaryProvider,
} from './nodeBinaryProvider';
import { IProcessTelemetry, IRunData, NodeLauncherBase } from './nodeLauncherBase';
import { INodeTargetLifecycleHooks } from './nodeTarget';
import { IPackageJsonProvider } from './packageJsonProvider';
import { IProgramLauncher } from './processLauncher';
import { CombinedProgram, WatchDogProgram } from './program';
import { IRestartPolicy, RestartPolicyFactory } from './restartPolicy';
import { WatchDog } from './watchdogSpawn';

/**
 * Tries to get the "program" entrypoint from the config. It a program
 * is explicitly provided, it grabs that, otherwise it looks for the first
 * existent path within the launch arguments.
 */
const tryGetProgramFromArgs = async (fsUtils: IFsUtils, config: INodeLaunchConfiguration) => {
  if (typeof config.stopOnEntry === 'string') {
    return resolve(config.cwd, config.stopOnEntry);
  }

  if (config.program) {
    return resolve(config.cwd, config.program);
  }

  for (const arg of asArray(config.args)) {
    if (arg.startsWith('-')) {
      // looks like a flag
      continue;
    }

    const candidate = resolve(config.cwd, arg);
    if (await fsUtils.exists(candidate)) {
      return candidate;
    }
  }

  return undefined;
};

@injectable()
export class NodeLauncher extends NodeLauncherBase<INodeLaunchConfiguration> {
  private attachSimplePort?: number;

  constructor(
    @inject(INodeBinaryProvider) pathProvider: INodeBinaryProvider,
    @inject(ILogger) logger: ILogger,
    @inject(IBreakpointsPredictor) private readonly bpPredictor: IBreakpointsPredictor,
    @multiInject(IProgramLauncher) private readonly launchers: ReadonlyArray<IProgramLauncher>,
    @inject(RestartPolicyFactory) private readonly restarters: RestartPolicyFactory,
    @inject(IFsUtils) private readonly fsUtils: LocalFsUtils,
    @inject(IPackageJsonProvider) private readonly packageJson: IPackageJsonProvider,
    @inject(ISourcePathResolverFactory) pathResolverFactory: ISourcePathResolverFactory,
    @inject(IPortLeaseTracker) portLeaseTracker: IPortLeaseTracker,
  ) {
    super(pathProvider, logger, portLeaseTracker, pathResolverFactory);
  }

  /**
   * @inheritdoc
   */
  protected resolveParams(params: AnyLaunchConfiguration): INodeLaunchConfiguration | undefined {
    let config: INodeLaunchConfiguration | undefined;
    if (params.type === DebugType.Node && params.request === 'launch') {
      config = { ...params };
    } else if ('server' in params && params.server && 'program' in params.server) {
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
    if (runData.params.program) {
      runData.params.program = await this.tryGetCompiledFile(runData.params.program);
    }

    this.attachSimplePort = await this.getSimpleAttachPortIfAny(runData.params);
    const doLaunch = async (restartPolicy: IRestartPolicy) => {
      // Close any existing program. We intentionally don't wait for stop() to
      // finish, since doing so will shut down the server.
      if (this.program) {
        this.program.stop(); // intentionally not awaited on
      }

      const binary = await this.resolveNodePath(
        runData.params,
        runData.params.runtimeExecutable || undefined,
      );

      const warning = binary.warning;
      if (warning) {
        runData.context.dap.output({
          category: 'stderr',
          output: warning.message,
        });
      }

      const callbackFile = new CallbackFile<IProcessTelemetry>();
      let env = await this.resolveEnvironment(runData, binary, {
        fileCallback: callbackFile.path,
      });

      if (this.attachSimplePort) {
        if (!runData.params.attachSimplePort) {
          runData.context.dap.output({
            category: 'stderr',
            output:
              'Using legacy attach mode for --inspect-brk in npm scripts. We recommend removing --inspect-brk, and using `stopOnEntry` in your launch.json if you need it.',
          });
        }

        env = env.merge({ NODE_OPTIONS: null });
      } else {
        env = hideDebugInfoFromConsole(binary, env);
      }

      const options: INodeLaunchConfiguration = { ...runData.params, env: env.value };
      const experimentalNetworkFlag = '--experimental-network-inspection';
      if (runData.params.experimentalNetworking === 'off') {
        // no-op
      } else if (
        binary.has(Capability.UseExperimentalNetworking)
        || runData.params.experimentalNetworking === 'on'
      ) {
        options.runtimeArgs = [experimentalNetworkFlag, ...options.runtimeArgs];
      }

      const launcher = this.launchers.find(l => l.canLaunch(options));
      if (!launcher) {
        throw new Error('Cannot find an appropriate launcher for the given set of options');
      }

      let program = await launcher.launchProgram(binary.path, options, runData.context);

      if (this.attachSimplePort) {
        const wd = await WatchDog.attach({
          ipcAddress: runData.serverAddress,
          scriptName: 'Remote Process',
          inspectorURL: await retryGetNodeEndpoint(
            `http://127.0.0.1:${this.attachSimplePort}`,
            runData.context.cancellationToken,
            this.logger,
          ),
          waitForDebugger: true,
          dynamicAttach: true,
        });

        program = new CombinedProgram(program, new WatchDogProgram(wd));
      } else {
        // Read the callback file, and signal the running program when we read data.
        callbackFile.read().then(data => {
          if (data) {
            program.gotTelemetery(data);
          }
        });
      }

      this.program = program;

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
    };

    return doLaunch(this.restarters.create(runData.params.restart));
  }

  /**
   * Detects if the user wants to run an npm script that contains --inspect-brk.
   * If so, it returns the port to attach with, instead of using the bootloader.
   * @see https://github.com/microsoft/vscode-js-debug/issues/584
   */
  protected async getSimpleAttachPortIfAny(params: INodeLaunchConfiguration) {
    if (params.attachSimplePort) {
      return params.attachSimplePort;
    }

    const script = getRunScript(params.runtimeExecutable, params.runtimeArgs);
    if (!script) {
      return;
    }

    const packageJson = await this.packageJson.getContents();
    if (!packageJson?.scripts?.[script]?.includes('--inspect-brk')) {
      return;
    }

    return params.port ?? 9229;
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
        if (this.attachSimplePort) {
          await this.gatherTelemetryFromCdp(cdp, run);
        }

        if (!run.params.stopOnEntry) {
          return;
        }

        // This is not an ideal stop-on-entry setup. The previous debug adapter
        // had life easier because it could ask the Node process to stop from
        // the get-go, but in our scenario the bootloader is the first thing
        // which is run and something we don't want to break in. We just
        // do our best to find the entrypoint from the run params.
        const program = await tryGetProgramFromArgs(this.fsUtils, run.params);
        if (!program) {
          this.logger.warn(LogTag.Runtime, 'Could not resolve program entrypointfrom args');
          return;
        }

        const breakpointId = '(?:entryBreakpoint){0}';
        const breakpointPath = absolutePathToFileUrl(program);
        const urlRegexp = urlToRegex(breakpointPath) + breakpointId;
        const breakpoint = await cdp.Debugger.setBreakpointByUrl({
          urlRegex: urlRegexp,
          lineNumber: 0,
          columnNumber: 0,
        });

        return breakpoint?.breakpointId
          ? { cdpId: breakpoint?.breakpointId, path: breakpointPath }
          : undefined;
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

  /**
   * Gets the compiled version of the given target program, if it exists and
   * we can find it. Otherwise we fall back to evaluating it directly.
   * @see https://github.com/microsoft/vscode-js-debug/issues/291
   */
  private async tryGetCompiledFile(targetProgram: string) {
    targetProgram = fixDriveLetterAndSlashes(targetProgram);

    const ext = extname(targetProgram);
    if (!ext || ext === '.js') {
      return targetProgram;
    }

    const mapped = await this.bpPredictor.getPredictionForSource(targetProgram);
    if (!mapped || mapped.size === 0) {
      return targetProgram;
    }

    // There can be more than one compile file per source file. Just pick
    // whichever one in that case.
    const entry = iteratorFirst(mapped.values());
    if (!entry) {
      return targetProgram;
    }

    this.logger.info(LogTag.RuntimeLaunch, 'Updating entrypoint to compiled file', {
      from: targetProgram,
      to: entry.compiledPath,
      candidates: mapped.size,
    });

    return entry.compiledPath;
  }
}
