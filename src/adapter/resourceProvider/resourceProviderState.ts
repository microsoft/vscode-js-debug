/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { Headers } from 'got';
import { injectable } from 'inversify';
import Cdp from '../../cdp/api';
import { IDisposable } from '../../common/disposable';
import { addHeader } from './helpers';

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
  public async apply(url: string, headers: Headers): Promise<Headers> {
    const cdp = this.cdp[0];
    if (cdp) {
      headers = await this.applyCookies(cdp, url, headers);
    }

    // Todo: are schemes such as HTTP Basic Auth something we'd like to support here?

    return headers;
  }

  private async applyCookies(cdp: Cdp.Api, url: string, headers: Headers) {
    await cdp.Network.enable({});

    const cookies = await cdp.Network.getCookies({ urls: [url] });
    if (!cookies?.cookies?.length) {
      return headers;
    }

    return addHeader(
      headers,
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
