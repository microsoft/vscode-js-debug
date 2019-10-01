// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import Dap from "../dap/api";

export interface CommonLaunchParams extends Dap.LaunchParams {
  rootPath?: string;
  logging?: { dap?: string, cdp?: string };
}
