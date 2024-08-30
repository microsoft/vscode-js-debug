/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { injectable } from 'inversify';
import { commands, ExtensionContext } from 'vscode';
import { Commands, registerCommand } from '../common/contributionUtils';
import { IExtensionContribution } from '../ioc-extras';

@injectable()
export class StartDebugingAndStopOnEntry implements IExtensionContribution {
  public register(context: ExtensionContext) {
    context.subscriptions.push(
      registerCommand(
        commands,
        Commands.StartWithStopOnEntry,
        () =>
          commands.executeCommand('workbench.action.debug.start', {
            config: {
              stopOnEntry: true,
            },
          }),
      ),
    );
  }
}
