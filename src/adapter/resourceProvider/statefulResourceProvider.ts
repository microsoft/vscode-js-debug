/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { Headers } from 'got';
import { inject, injectable, optional } from 'inversify';
import { CancellationToken } from 'vscode';
import { Response } from '.';
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

  protected async fetchHttp(
    url: string,
    cancellationToken: CancellationToken,
    headers: Headers = {},
  ): Promise<Response<string>> {
    const res = await super.fetchHttp(url, cancellationToken, headers);
    if (!res.ok) {
      const updated = await this.state.apply(url, headers);
      if (updated !== headers) {
        return await super.fetchHttp(url, cancellationToken, updated);
      }
    }

    return res;
  }
}
