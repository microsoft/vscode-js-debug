/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { CancellationToken } from 'vscode';

export interface IResourceProvider {
  /**
   * Returns data from the given file, data, or HTTP URL.
   */
  fetch(url: string, cancellationToken?: CancellationToken): Promise<Response<string>>;

  /**
   * Returns JSON from the given file, data, or HTTP URL.
   */
  fetchJson<T>(url: string, cancellationToken?: CancellationToken): Promise<Response<T>>;
}

/**
 * Error type thrown for a non-2xx status code.
 */
export class HttpStatusError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly url: string,
    public readonly body?: string,
  ) {
    super(`Unexpected ${statusCode} response from ${url}`);
  }
}

/**
 * Succe
 */
export interface ISuccessfulResponse<T> {
  ok: true;
  body: T;
  statusCode: number;
}

export interface IErrorResponse {
  ok: false;
  statusCode: number;
  error: Error;
  body?: string;
}

export type Response<T> = ISuccessfulResponse<T> | IErrorResponse;

export const IResourceProvider = Symbol('IResourceProvider');
