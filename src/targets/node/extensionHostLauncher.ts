/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { existsSync, lstatSync } from 'fs';
import { injectable } from 'inversify';
import { DebugType } from '../../common/contributionUtils';
import { findOpenPort } from '../../common/findOpenPort';
import { AnyLaunchConfiguration, IExtensionHostLaunchConfiguration } from '../../configuration';
import Dap from '../../dap/api';
import { VSCodeRendererAttacher } from '../browser/vscodeRendererAttacher';
import { IRunData, NodeLauncherBase } from './nodeLauncherBase';
import { StubProgram } from './program';

/**
 * Boots an instance of VS Code for extension debugging. Once this happens,
 * a separate "attach" request will come in.
 */
@injectable()
export class ExtensionHostLauncher extends NodeLauncherBase<IExtensionHostLaunchConfiguration> {
  /**
   * @inheritdoc
   */
  protected resolveParams(
    params: AnyLaunchConfiguration,
  ): IExtensionHostLaunchConfiguration | undefined {
    return params.type === DebugType.ExtensionHost && params.request === 'launch'
      ? params
      : undefined;
  }

  /**
   * @inheritdoc
   */
  protected async launchProgram(
    runData: IRunData<IExtensionHostLaunchConfiguration>,
  ): Promise<void> {
    const port = runData.params.port || (await findOpenPort());
    const result = await runData.context.dap.launchVSCodeRequest({
      args: resolveCodeLaunchArgs(runData.params, port),
      env: this.getConfiguredEnvironment(runData.params).defined(),
      debugRenderer: runData.params.debugWebviews || runData.params.debugWebWorkerHost,
    });

    if (result.rendererDebugAddr) {
      VSCodeRendererAttacher.debugIdTorendererDebugAddr.set(
        runData.params.__sessionId,
        result.rendererDebugAddr,
      );
    }

    this.program = new StubProgram();
    this.program.stop();
  }
}

const resolveCodeLaunchArgs = (launchArgs: IExtensionHostLaunchConfiguration, port: number) => {
  // Separate all "paths" from an arguments into separate attributes.
  const args = launchArgs.args.map<Dap.LaunchVSCodeArgument>(arg => {
    if (arg.startsWith('-')) {
      // arg is an option
      const pair = arg.split('=', 2);
      if (pair.length === 2 && (existsSync(pair[1]) || existsSync(pair[1] + '.js'))) {
        return { prefix: pair[0] + '=', path: pair[1] };
      }
      return { prefix: arg };
    } else {
      // arg is a path
      try {
        const stat = lstatSync(arg);
        if (stat.isDirectory()) {
          return { prefix: '--folder-uri=', path: arg };
        } else if (stat.isFile()) {
          return { prefix: '--file-uri=', path: arg };
        }
      } catch (err) {
        // file not found
      }
      return { path: arg }; // just return the path blindly and hope for the best...
    }
  });

  if (!launchArgs.noDebug) {
    args.unshift({ prefix: `--inspect-brk-extensions=${port}` });
  }

  args.unshift({ prefix: `--debugId=${launchArgs.__sessionId}` }); // pass the debug session ID so that broadcast events know where they come from

  return args;
};
