// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import Dap from "../dap/api";

export function reportToConsole(dap: Dap.Api, error: string) {
  dap.output({
    category: 'console',
    output: error + '\n'
  });
};

export function createSilentError(text: string): Dap.Error {
  return {
    __errorMarker: true,
    error: {
      id: 9222,
      format: text,
      showUser: false
    }
  };
};

export function createUserError(text: string): Dap.Error {
  return {
    __errorMarker: true,
    error: {
      id: 9223,
      format: text,
      showUser: true
    }
  };
};
