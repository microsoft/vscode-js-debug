/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { IResourceProvider } from '.';
import { injectable, inject } from 'inversify';
import { NeverCancelled, TaskCancelledError } from '../../common/cancellation';
import { FS, FsPromises } from '../../ioc-extras';
import { CancellationToken } from 'vscode';
import { fileUrlToAbsolutePath, isAbsolute, isLoopback } from '../../common/urlUtils';
import * as https from 'https';
import * as http from 'http';
import { DisposableList } from '../../common/disposable';
import { AnyRequestOptions } from './resourceProviderState';

@injectable()
export class BasicResourceProvider implements IResourceProvider {
  constructor(@inject(FS) private readonly fs: FsPromises) {}

  /**
   * @inheritdoc
   */
  public fetch(url: string, cancellationToken: CancellationToken = NeverCancelled) {
    if (url.startsWith('data:')) {
      return this.resolveDataUri(url);
    }

    const absolutePath = isAbsolute(url) ? url : fileUrlToAbsolutePath(url);
    if (absolutePath) {
      return this.fs.readFile(absolutePath, 'utf-8');
    }

    return this.fetchHttp(url, cancellationToken);
  }
  /**
   * Returns JSON from the given file, data, or HTTP URL.
   */
  public async fetchJson<T>(url: string, cancellationToken?: CancellationToken): Promise<T> {
    return JSON.parse(await this.fetch(url, cancellationToken));
  }

  private async fetchHttp(url: string, cancellationToken: CancellationToken) {
    const isSecure = !url.startsWith('http://');
    const driver = isSecure ? https : http;
    const [targetAddressIsLoopback, options] = await Promise.all([
      isLoopback(url),
      this.createHttpOptions(url),
    ]);

    if (isSecure && targetAddressIsLoopback) {
      options.rejectUnauthorized = false;
    }

    const disposables = new DisposableList();

    // Todo: swap this out with a richer library. `got` recently added http/2
    // support and supports compressed responses, look at that when it exits beta.

    return new Promise<string>((fulfill, reject) => {
      const request = driver.request(url, options, response => {
        disposables.push(cancellationToken.onCancellationRequested(() => response.destroy()));

        let data = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => (data += chunk));
        response.on('end', () => fulfill(data));
        response.on('error', reject);
      });

      disposables.push(
        cancellationToken.onCancellationRequested(() => {
          request.destroy();
          reject(new TaskCancelledError(`Cancelled GET ${url}`));
        }),
      );

      request.on('error', reject);
      request.end();
    }).finally(() => disposables.dispose());
  }

  private resolveDataUri(url: string) {
    const prefix = url.substring(0, url.indexOf(','));
    const match = prefix.match(/data:[^;]*(;[^;]*)?(;[^;]*)?(;[^;]*)?/);
    if (!match) {
      throw new Error(`Malformed data url prefix '${prefix}'`);
    }

    const params = new Set<string>(match.slice(1));
    const data = url.substring(prefix.length + 1);
    const result = Buffer.from(data, params.has(';base64') ? 'base64' : undefined).toString();
    return Promise.resolve(result);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected createHttpOptions(url: string): Promise<AnyRequestOptions> {
    return Promise.resolve({});
  }
}
