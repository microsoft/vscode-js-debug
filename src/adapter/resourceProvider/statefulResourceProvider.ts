/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { OptionsOfTextResponseBody } from 'got';
import { inject, injectable, optional } from 'inversify';
import Cdp from '../../cdp/api';
import { ICdpApi } from '../../cdp/connection';
import { DisposableList, IDisposable } from '../../common/disposable';
import { FS, FsPromises } from '../../ioc-extras';
import { BasicResourceProvider } from './basicResourceProvider';
import { ResourceProviderState } from './resourceProviderState';

@injectable()
export class StatefulResourceProvider extends BasicResourceProvider implements IDisposable {
  private readonly disposables = new DisposableList();

  constructor(
    @inject(FS) fs: FsPromises,
    @inject(ResourceProviderState) private readonly state: ResourceProviderState,
    @optional() @inject(ICdpApi) cdp?: Cdp.Api,
  ) {
    super(fs);
    if (cdp) {
      this.disposables.push(this.state.attach(cdp));
    }
  }

  /**
   * @inheritdoc
   */
  public dispose() {
    this.disposables.dispose();
  }

  protected async createHttpOptions(url: string): Promise<OptionsOfTextResponseBody> {
    return this.state.apply(url, await super.createHttpOptions(url));
  }
}
