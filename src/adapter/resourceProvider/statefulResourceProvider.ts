/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { Headers } from 'got';
import { inject, injectable, optional } from 'inversify';
import { CancellationToken } from 'vscode';
import Cdp from '../../cdp/api';
import { ICdpApi } from '../../cdp/connection';
import { DisposableList, IDisposable } from '../../common/disposable';
import { ILogger, LogTag } from '../../common/logging';
import { FS, FsPromises } from '../../ioc-extras';
import { ITarget } from '../../targets/targets';
import { Response } from '.';
import { BasicResourceProvider } from './basicResourceProvider';
import { IRequestOptionsProvider } from './requestOptionsProvider';

@injectable()
export class StatefulResourceProvider extends BasicResourceProvider implements IDisposable {
  private readonly disposables = new DisposableList();

  constructor(
    @inject(FS) fs: FsPromises,
    @inject(ILogger) private readonly logger: ILogger,
    @optional() @inject(ITarget) private readonly target?: ITarget,
    @optional() @inject(ICdpApi) private readonly cdp?: Cdp.Api,
    @optional() @inject(IRequestOptionsProvider) options?: IRequestOptionsProvider,
  ) {
    super(fs, options);
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
      this.logger.info(LogTag.Runtime, 'Network load failed, falling back to CDP', { url, res });
      return this.fetchOverBrowserNetwork(url, res);
    }

    return res;
  }

  private async fetchOverBrowserNetwork(
    url: string,
    original: Response<string>,
  ): Promise<Response<string>> {
    if (!this.cdp) {
      return original;
    }

    const res = await this.cdp.Network.loadNetworkResource({
      // Browser targets use the frame ID as their target ID.
      frameId: this.target?.targetInfo.targetId,
      url,
      options: {
        includeCredentials: true,
        disableCache: true,
      },
    });

    if (!res) {
      return original;
    }

    if (
      !res.resource.success
      || !res.resource.httpStatusCode
      || res.resource.httpStatusCode >= 400
      || !res.resource.stream
    ) {
      return original;
    }

    // Small optimization: normally we'd need a trailing `IO.read` request to
    // get an EOF, but if the response headers have a length then we can avoid that!
    let maxOffset = Number(res.resource.headers?.['Content-Length']);
    if (isNaN(maxOffset)) {
      maxOffset = Infinity;
    }

    const result: string[] = [];
    let offset = 0;
    while (true) {
      const chunkRes = await this.cdp.IO.read({ handle: res.resource.stream, offset });
      if (!chunkRes) {
        this.logger.info(LogTag.Runtime, 'Stream error encountered in middle, falling back', {
          url,
        });
        return original;
      }

      const chunk = chunkRes.base64Encoded
        ? Buffer.from(chunkRes.data, 'base64').toString()
        : chunkRes.data;
      // V8 uses byte length, not UTF-16 length, see #1814
      offset += Buffer.byteLength(chunk, 'utf-8');
      result.push(chunk);
      if (offset >= maxOffset) {
        this.cdp.IO.close({ handle: res.resource.stream }); // no await: do this in the background
        break;
      }

      if (chunkRes.eof) {
        break;
      }
    }

    return {
      ok: true,
      body: result.join(''),
      statusCode: res.resource.httpStatusCode,
      url,
    };
  }
}
