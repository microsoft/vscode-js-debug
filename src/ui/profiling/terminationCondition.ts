/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import Dap from '../../dap/api';
import { UiProfileSession } from './uiProfileSession';
import { IDisposable } from '../../common/disposable';
import { DebugSession } from 'vscode';

/**
 * Item displayed to the user when picking when their profile should end.
 */
export interface ITerminationConditionFactory {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly sortOrder: number;

  /**
   * Called when the user picks this termination factory. Can return undefined
   * to cancel the picking process.
   */
  onPick(
    session: DebugSession,
    ...args: ReadonlyArray<unknown>
  ): Promise<ITerminationCondition | undefined>;
}

export const ITerminationConditionFactory = Symbol('ITerminationConditionFactory');

export interface ITerminationCondition extends IDisposable {
  /**
   * Custom object to be merged into the `startProfile` request.
   */
  readonly customData?: Partial<Dap.StartProfileParams>;

  /**
   * Called when the profile starts running.
   */
  attachTo?(session: UiProfileSession): void;
}
