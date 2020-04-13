/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { CancellationToken } from 'vscode';

export interface IResourceProvider {
  /**
   * Returns data from the given file, data, or HTTP URL.
   */
  fetch(url: string, cancellationToken?: CancellationToken): Promise<string>;

  /**
   * Returns JSON from the given file, data, or HTTP URL.
   */
  fetchJson<T>(url: string, cancellationToken?: CancellationToken): Promise<T>;
}

export const IResourceProvider = Symbol('IResourceProvider');
