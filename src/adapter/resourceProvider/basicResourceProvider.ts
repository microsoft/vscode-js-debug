/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import dataUriToBuffer from 'data-uri-to-buffer';
import got, { OptionsOfTextResponseBody, RequestError } from 'got';
import { inject, injectable } from 'inversify';
import { CancellationToken } from 'vscode';
import { HttpStatusError, IResourceProvider, Response } from '.';
import { NeverCancelled } from '../../common/cancellation';
import { DisposableList } from '../../common/disposable';
import { fileUrlToAbsolutePath, isAbsolute, isLoopback } from '../../common/urlUtils';
import { FS, FsPromises } from '../../ioc-extras';

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
    try {
      const r = dataUriToBuffer(url);
      return { ok: true, body: r.toString('utf-8'), statusCode: 200 };
    } catch {
      // assume it's a remote url
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
    const [targetAddressIsLoopback, options] = await Promise.all([
      isLoopback(url),
      this.createHttpOptions(url),
    ]);

    if (isSecure && targetAddressIsLoopback) {
      options.rejectUnauthorized = false;
    }

    options.followRedirect = true;
    options.headers = { ...options.headers, ...headers };

    const disposables = new DisposableList();

    try {
      const request = got(url, options);
      disposables.push(cancellationToken.onCancellationRequested(() => request.cancel()));

      const response = await request;
      return { ok: true, body: response.body, statusCode: response.statusCode };
    } catch (error) {
      if (!(error instanceof RequestError)) {
        throw error;
      }

      const body = error.response ? String(error.response?.body) : error.message;
      const statusCode = error.response?.statusCode ?? 503;
      return {
        ok: false,
        body,
        statusCode,
        error: new HttpStatusError(statusCode, url, body),
      };
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected createHttpOptions(url: string): Promise<OptionsOfTextResponseBody> {
    return Promise.resolve({});
  }
}
