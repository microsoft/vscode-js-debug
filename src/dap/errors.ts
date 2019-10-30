// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import Dap from './api';
import * as nls from 'vscode-nls';

const localize = nls.loadMessageBundle();

export const enum ErrorCodes {
  SilentError = 9222,
  UserError,
  NvmNotFound,
  NvmHomeNotFound,
  CannotLaunchInTerminal,
  CannotLoadEnvironmentVariables
}

export function reportToConsole(dap: Dap.Api, error: string) {
  dap.output({
    category: 'console',
    output: error + '\n',
  });
}

export function createSilentError(text: string): Dap.Error {
  return {
    __errorMarker: true,
    error: {
      id: ErrorCodes.SilentError,
      format: text,
      showUser: false,
    },
  };
}

export function createUserError(text: string, code = ErrorCodes.UserError): Dap.Error {
  return {
    __errorMarker: true,
    error: {
      id: code,
      format: text,
      showUser: true,
    },
  };
}

export const nvmNotFound = () =>
  createUserError(
    localize(
      'NVS_HOME.not.found.message',
      "Attribute 'runtimeVersion' requires Node.js version manager 'nvs'.",
    ),
    ErrorCodes.NvmNotFound,
  );

export const nvmHomeNotFound = () =>
  createUserError(
    localize(
      'NVM_HOME.not.found.message',
      "Attribute 'runtimeVersion' requires Node.js version manager 'nvm-windows' or 'nvs'.",
    ),
    ErrorCodes.NvmHomeNotFound,
  );

export const nvmVersionNotFound = (version: string, versionManager: string) =>
  createUserError(
    localize(
      'runtime.version.not.found.message',
      "Node.js version '{0}' not installed for '{1}'.",
      version,
      versionManager,
    ),
    ErrorCodes.NvmHomeNotFound,
  );

export const cannotLaunchInTerminal = (errorMessage: string) =>
  createUserError(
    localize('VSND2011', 'Cannot launch debug target in terminal ({0}).', errorMessage),
    ErrorCodes.CannotLaunchInTerminal,
  );

export const cannotLoadEnvironmentVars = (errorMessage: string) =>
  createUserError(
    localize('VSND2029', "Can't load environment variables from file ({0}).", errorMessage),
    ErrorCodes.CannotLoadEnvironmentVariables,
  );

export class ProtocolError extends Error {
  public readonly cause: Dap.Message;

  constructor(cause: Dap.Message | Dap.Error) {
    super('__errorMarker' in cause ? cause.error.format : cause.format);
    this.cause = '__errorMarker' in cause ? cause.error : cause;
  }
}
