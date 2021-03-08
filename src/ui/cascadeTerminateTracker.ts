/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { inject, injectable } from 'inversify';
import * as vscode from 'vscode';
import { IExtensionContribution } from '../ioc-extras';
import { DebugSessionTracker } from './debugSessionTracker';

/**
 * Watches for sessions to be terminated. When they are, it runs cascading
 * termination if configured.
 */
@injectable()
export class CascadeTerminationTracker implements IExtensionContribution {
  constructor(@inject(DebugSessionTracker) private readonly tracker: DebugSessionTracker) {}

  /**
   * Registers the tracker for the extension.
   */
  public register(context: vscode.ExtensionContext) {
    context.subscriptions.push(
      this.tracker.onSessionEnded(session => {
        const targets: string[] = session.configuration.cascadeTerminateToConfigurations;
        if (!targets || !(targets instanceof Array)) {
          return; // may be a nested session
        }

        for (const configName of targets) {
          for (const session of this.tracker.getByName(configName)) {
            vscode.debug.stopDebugging(session);
          }
        }
      }),
    );
  }
}
