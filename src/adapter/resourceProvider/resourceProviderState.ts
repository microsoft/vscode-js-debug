/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { injectable } from 'inversify';
import Cdp from '../../cdp/api';
import { IDisposable } from '../../common/disposable';
import { RequestOptions as HttpsRequestOptions } from 'https';
import { RequestOptions as HttpRequestOptions } from 'https';
import { addHeader } from './helpers';

export type AnyRequestOptions = HttpsRequestOptions | HttpRequestOptions;

/**
 * Provides state shared between all IResourceProviders.
 */
@injectable()
export class ResourceProviderState {
  private cdp: Cdp.Api[] = [];

  /**
   * Listens to the CDP API, monitoring requests.
   */
  public attach(cdp: Cdp.Api): IDisposable {
    this.cdp.push(cdp);

    return {
      dispose: () => {
        this.cdp = this.cdp.filter(c => c !== cdp);
      },
    };
  }

  /**
   * Applies state overrides to the request options.
   */
  public async apply(url: string, options: AnyRequestOptions): Promise<AnyRequestOptions> {
    const cdp = this.cdp[0];
    if (cdp) {
      options = await this.applyCookies(cdp, url, options);
    }

    // Todo: are schemes such as HTTP Basic Auth something we'd like to support here?

    return options;
  }

  private async applyCookies(cdp: Cdp.Api, url: string, options: AnyRequestOptions) {
    const cookies = await cdp.Network.getCookies({ urls: [url] });
    if (!cookies?.cookies?.length) {
      return options;
    }

    return addHeader(
      options,
      'Cookie',
      cookies.cookies
        // By spec, cookies with shorter paths should be sorted before longer ones
        .sort((a, b) => a.path.length - b.path.length)
        // Cookies cannot have = in their keys or ; in their values, no escaping needed
        .map(c => `${c.name}=${c.value}`)
        .join('; '),
    );
  }
}
