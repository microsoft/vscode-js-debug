/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as path from 'path';
import { asArray } from '../../common/arrayUtils';
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

export const getNodeLaunchArgs = (config: INodeLaunchConfiguration): string[] => {
  let program = config.program;
  if (program && path.isAbsolute(program)) {
    const maybeRel = path.relative(config.cwd, program);
    program = path.isAbsolute(maybeRel) ? maybeRel : `.${path.sep}${maybeRel}`;
  }

  return program
    ? [...config.runtimeArgs, program, ...asArray(config.args)]
    : [...config.runtimeArgs, ...asArray(config.args)];
};
