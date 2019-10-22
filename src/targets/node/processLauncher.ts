// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as path from 'path';
import * as nls from 'vscode-nls';
import { INodeLaunchConfiguration } from '../../configuration';
import { ProtocolError } from '../../dap/errors';
import { findInPath, findExecutable } from '../../common/pathUtils';
import { ILaunchContext } from '../targets';
import { IProgram } from './program';
import { EnvironmentVars } from '../../common/environmentVars';

const localize = nls.loadMessageBundle();
/**
 * Interface that handles booting a program to debug.
 */
export interface IProgramLauncher {
  /**
   * Returns whether this launcher is appropriate for the given set of options.
   */
  canLaunch(args: INodeLaunchConfiguration): boolean;

  /**
   * Executs the program.
   */
  launchProgram(args: INodeLaunchConfiguration, context: ILaunchContext): Promise<IProgram>;
}

/**
 * Launcher that boots a subprocess.
 */
export abstract class ProcessLauncher implements IProgramLauncher {
  public canLaunch(_args: INodeLaunchConfiguration): boolean {
    return true;
  }

  public abstract launchProgram(
    args: INodeLaunchConfiguration,
    context: ILaunchContext,
  ): Promise<IProgram>;

  protected getRuntime(args: INodeLaunchConfiguration) {
    let requestedRuntime = args.runtimeExecutable || 'node';
    const env = EnvironmentVars.merge(process.env, args.env).value;
    const resolvedRuntime = findExecutable(
      path.isAbsolute(requestedRuntime) ? requestedRuntime : findInPath(requestedRuntime, env),
      env,
    );

    if (!resolvedRuntime) {
      throw new ProtocolError({
        id: 2001,
        format: localize(
          'VSND2001',
          "Cannot find runtime '{0}' on PATH. Make sure to have '{0}' installed.",
          requestedRuntime,
        ),
        showUser: true,
        variables: { _runtime: requestedRuntime },
      });
    }

    return resolvedRuntime;
  }
}
