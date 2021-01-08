/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { OptionsOfTextResponseBody } from 'got';
import { injectable } from 'inversify';
import { workspace } from 'vscode';
import { mergeOptions } from '../adapter/resourceProvider/helpers';
import { IRequestOptionsProvider } from '../adapter/resourceProvider/requestOptionsProvider';
import { Configuration, readConfig } from '../common/contributionUtils';
import { once } from '../common/objUtils';

@injectable()
export class SettingRequestOptionsProvider implements IRequestOptionsProvider {
  private readonly read = once(() => readConfig(workspace, Configuration.ResourceRequestOptions));

  /**
   * @inheritdoc
   */
  public provideOptions(obj: OptionsOfTextResponseBody) {
    mergeOptions(obj, (this.read() || {}) as Partial<OptionsOfTextResponseBody>);
  }
}
