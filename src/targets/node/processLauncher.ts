/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

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
