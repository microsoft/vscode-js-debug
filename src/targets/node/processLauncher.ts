/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as path from 'path';
import { INodeLaunchConfiguration } from '../../configuration';
import { ILaunchContext } from '../targets';
import { IProgram } from './program';

export const IProgramLauncher = Symbol('IProgramLauncher');

/**
 * Interface that handles booting a program to debug.
 */
export interface IProgramLauncher {
  /**
   * Returns whether this launcher is appropriate for the given set of options.
   */
  canLaunch(args: INodeLaunchConfiguration): boolean;

  /**
   * Executes the program.
   */
  launchProgram(
    binary: string,
    args: INodeLaunchConfiguration,
    context: ILaunchContext,
  ): Promise<IProgram>;
}

export const getNodeLaunchArgs = (config: INodeLaunchConfiguration) => {
  let program = config.program;
  if (program && path.isAbsolute(program)) {
    program = `.${path.sep}${path.relative(config.cwd, program)}`;
  }

  return program
    ? [...config.runtimeArgs, program, ...config.args]
    : [...config.runtimeArgs, ...config.args];
};
