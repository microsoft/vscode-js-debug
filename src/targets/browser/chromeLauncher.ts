/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { DebugType } from '../../common/contributionUtils';
import { IChromeLaunchConfiguration, AnyLaunchConfiguration } from '../../configuration';
import { injectable } from 'inversify';
import { BrowserLauncher } from './browserLauncher';

@injectable()
export class ChromeLauncher extends BrowserLauncher<IChromeLaunchConfiguration> {
  /**
   * @inheritdoc
   */
  protected resolveParams(params: AnyLaunchConfiguration) {
    return params.type === DebugType.Chrome && params.request === 'launch' ? params : undefined;
  }
}
