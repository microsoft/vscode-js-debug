// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import Dap from "../../dap/api";

export interface LaunchParams extends Dap.LaunchParams {
  url?: string;
  remoteDebuggingPort?: string,
  webRoot?: string;
}
