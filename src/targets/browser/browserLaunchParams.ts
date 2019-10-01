// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { URL } from "url";
import { CommonLaunchParams } from "../../common/commonLaunchParams";

export interface LaunchParams extends CommonLaunchParams {
  url?: string;
  remoteDebuggingPort?: string;
  port?: string;
  browserExecutable?: string;
  runtimeExecutable?: string;
  browserArgs?: string[];
  runtimeArgs?: string[];
  baseURL?: string;
  webRoot?: string;
}

export function baseURL(params: LaunchParams): string | undefined {
  if (params.baseURL)
    return params.baseURL;

  if (params.url) {
    try {
      const baseUrl = new URL(params.url);
      baseUrl.pathname = '/';
      baseUrl.search = '';
      baseUrl.hash = '';
      if (baseUrl.protocol === 'data:')
        return undefined;
      return baseUrl.href;
    } catch (e) {
    }
  }
}

