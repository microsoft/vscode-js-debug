/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { OptionsOfTextResponseBody } from 'got';

export interface IRequestOptionsProvider {
  /**
   * Called before requests are made, can be used to add
   * extra options into the request.
   */
  provideOptions(obj: OptionsOfTextResponseBody, url: string): void;
}

export const IRequestOptionsProvider = Symbol('IRequestOptionsProvider');
