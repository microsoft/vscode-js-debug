/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as http from 'http';
import * as https from 'https';
import { inject, injectable } from 'inversify';
import { CancellationToken } from 'vscode';
import { HttpStatusError, IResourceProvider, Response } from '.';
import { NeverCancelled, TaskCancelledError } from '../../common/cancellation';
import { DisposableList } from '../../common/disposable';
import { fileUrlToAbsolutePath, isAbsolute, isLoopback } from '../../common/urlUtils';
import { FS, FsPromises } from '../../ioc-extras';
import { AnyRequestOptions } from './resourceProviderState';

@injectable()
export class BasicResourceProvider implements IResourceProvider {
  constructor(@inject(FS) private readonly fs: FsPromises) {}

  /**
   * @inheritdoc
   */
  public async fetch(
    url: string,
    cancellationToken: CancellationToken = NeverCancelled,
    headers?: { [key: string]: string },
  ): Promise<Response<string>> {
    if (url.startsWith('data:')) {
      return this.resolveDataUri(url);
    }

    const absolutePath = isAbsolute(url) ? url : fileUrlToAbsolutePath(url);
    if (absolutePath) {
      try {
        return { ok: true, body: await this.fs.readFile(absolutePath, 'utf-8'), statusCode: 200 };
      } catch (error) {
        return { ok: false, error, statusCode: 200 };
      }
    }

    return this.fetchHttp(url, cancellationToken, headers);
  }
  /**
   * Returns JSON from the given file, data, or HTTP URL.
   */
  public async fetchJson<T>(
    url: string,
    cancellationToken?: CancellationToken,
    headers?: { [key: string]: string },
  ): Promise<Response<T>> {
    const res = await this.fetch(url, cancellationToken, {
      Accept: 'application/json',
      ...headers,
    });
    if (!res.ok) {
      return res;
    }

    try {
      return { ...res, body: JSON.parse(res.body) };
    } catch (error) {
      return { ...res, ok: false, error };
    }
  }

  private async fetchHttp(
    url: string,
    cancellationToken: CancellationToken,
    headers?: { [key: string]: string },
  ): Promise<Response<string>> {
    const isSecure = !url.startsWith('http://');
    const driver = isSecure ? https : http;
    const [targetAddressIsLoopback, options] = await Promise.all([
      isLoopback(url),
      this.createHttpOptions(url),
    ]);

    if (isSecure && targetAddressIsLoopback) {
      options.rejectUnauthorized = false;
    }

    options.headers = { ...options.headers, ...headers };

    const disposables = new DisposableList();

    // Todo: swap this out with a richer library. `got` recently added http/2
    // support and supports compressed responses, look at that when it exits beta.

    return new Promise<Response<string>>((resolve, reject) => {
      const request = driver.request(url, options, response => {
        disposables.push(cancellationToken.onCancellationRequested(() => response.destroy()));
        const statusCode = response.statusCode || 503;

        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => (body += chunk));
        response.on('end', () => {
          if (statusCode >= 400) {
            resolve({
              ok: false,
              body,
              statusCode,
              error: new HttpStatusError(statusCode, url, body),
            });
          } else {
            resolve({ ok: true, body, statusCode });
          }
        });
        response.on('error', error => resolve({ ok: false, error, statusCode }));
      });

      disposables.push(
        cancellationToken.onCancellationRequested(() => {
          request.destroy();
          resolve({
            ok: false,
            statusCode: 503,
            error: new TaskCancelledError(`Cancelled GET ${url}`),
          });
        }),
      );

      request.on('error', reject);
      request.end();
    }).finally(() => disposables.dispose());
  }

  private resolveDataUri(url: string): Response<string> {
    const prefix = url.substring(0, url.indexOf(','));
    const match = prefix.match(/data:[^;]*(;[^;]*)?(;[^;]*)?(;[^;]*)?/);
    if (!match) {
      return {
        ok: false,
        statusCode: 500,
        error: new Error(`Malformed data url prefix '${prefix}'`),
        body: url,
      };
    }

    const params = new Set<string>(match.slice(1));
    const data = url.substring(prefix.length + 1);
    const result = Buffer.from(data, params.has(';base64') ? 'base64' : undefined).toString();
    return { ok: true, statusCode: 200, body: result };
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected createHttpOptions(url: string): Promise<AnyRequestOptions> {
    return Promise.resolve({});
  }
}
