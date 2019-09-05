// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import Dap from "../../dap/api";
import { URL } from "url";

export interface LaunchParams extends Dap.LaunchParams {
  url?: string;
  remoteDebuggingPort?: string;
  baseURL?: string;
  webRoot?: string;
}

export function baseURL(params: LaunchParams): URL | undefined {
  if (params.baseURL) {
    try {
      return new URL(params.baseURL);
    } catch (e) {
    }
  }

  if (params.url) {
    try {
      const baseUrl = new URL(params.url);
      baseUrl.pathname = '/';
      baseUrl.search = '';
      baseUrl.hash = '';
      if (baseUrl.protocol === 'data:')
        return undefined;
      return baseUrl;
    } catch (e) {
    }
  }
}

