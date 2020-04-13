/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { injectable, inject, optional } from 'inversify';
import { FsPromises, FS } from '../../ioc-extras';
import { IDisposable, DisposableList } from '../../common/disposable';
import Cdp from '../../cdp/api';
import { ICdpApi } from '../../cdp/connection';
import { ResourceProviderState, AnyRequestOptions } from './resourceProviderState';
import { BasicResourceProvider } from './basicResourceProvider';

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

  protected async createHttpOptions(url: string): Promise<AnyRequestOptions> {
    return this.state.apply(url, await super.createHttpOptions(url));
  }
}
