/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { inject, injectable } from 'inversify';
import * as vscode from 'vscode';
import { Commands, ContextKey, registerCommand } from '../common/contributionUtils';
import { ExtensionContext, IExtensionContribution } from '../ioc-extras';
import { DebugSessionTracker } from './debugSessionTracker';
import { ManagedContextKey } from './managedContextKey';
import { ManagedState } from './managedState';

export const sourceMapSteppingEnabled = new ManagedState('sourceSteppingEnabled', true);

@injectable()
export class SourceSteppingUI implements IExtensionContribution {
  constructor(
    @inject(ExtensionContext) private readonly context: vscode.ExtensionContext,
    @inject(DebugSessionTracker) private readonly tracker: DebugSessionTracker,
  ) {}

  /** @inheritdoc */
  public register(context: vscode.ExtensionContext) {
    const isDisabled = new ManagedContextKey(ContextKey.IsMapSteppingDisabled);

    if (sourceMapSteppingEnabled.read(this.context.workspaceState) === false) {
      isDisabled.value = true;
    }

    const setEnabled = (enabled: boolean) => {
      isDisabled.value = !enabled;
      sourceMapSteppingEnabled.write(this.context.workspaceState, enabled);
      for (const session of this.tracker.getConcreteSessions()) {
        session.customRequest('setSourceMapStepping', { enabled });
      }
    };

    context.subscriptions.push(
      registerCommand(vscode.commands, Commands.EnableSourceMapStepping, () => {
        setEnabled(true);
      }),
      registerCommand(vscode.commands, Commands.DisableSourceMapStepping, () => {
        setEnabled(false);
      }),
    );
  }
}
