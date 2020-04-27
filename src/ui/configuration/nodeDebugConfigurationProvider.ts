/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as vscode from 'vscode';
import { injectable } from 'inversify';
import { DebugType } from '../../common/contributionUtils';
import { createLaunchConfigFromContext } from './nodeDebugConfigurationResolver';
import { BaseConfigurationProvider } from './baseConfigurationProvider';
import { AnyNodeConfiguration } from '../../configuration';

@injectable()
export class NodeDebugConfigurationProvider extends BaseConfigurationProvider<
  AnyNodeConfiguration
> {
  protected provide(folder?: vscode.WorkspaceFolder) {
    return createLaunchConfigFromContext(folder, true);
  }

  protected getType() {
    return DebugType.Node as const;
  }

  protected getTriggerKind() {
    return vscode.DebugConfigurationProviderTrigger.Initial;
  }
}
