/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import Dap from './api';
import * as nls from 'vscode-nls';

const localize = nls.loadMessageBundle();

export const enum ErrorCodes {
  SilentError = 9222,
  UserError,
  NvmNotFound,
  NvmHomeNotFound,
  CannotLaunchInTerminal,
  CannotLoadEnvironmentVariables,
  CannotFindNodeBinary,
  NodeBinaryOutOfDate,
  InvalidHitCondition,
  InvalidLogPointBreakpointSyntax,
  BrowserNotFound,
  AsyncScopesNotAvailable,
}

export function reportToConsole(dap: Dap.Api, error: string) {
  dap.output({
    category: 'console',
    output: error + '\n',
  });
}

export function createSilentError(text: string, code = ErrorCodes.SilentError): Dap.Error {
  return {
    __errorMarker: true,
    error: {
      id: code,
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

export const cannotFindNodeBinary = (attemptedPath: string) =>
  createUserError(
    localize(
      'runtime.node.notfound',
      'Can\'t find Node.js binary "{0}". Make sure Node.js is installed and in your PATH, or set the "runtimeExecutable" in your launch.json',
      attemptedPath,
    ),
    ErrorCodes.CannotFindNodeBinary,
  );

export const nodeBinaryOutOfDate = (readVersion: string, attemptedPath: string) =>
  createUserError(
    localize(
      'runtime.node.outdated',
      'The Node version in "{0}" is outdated (version {1}), we require at least Node 8.x.',
      attemptedPath,
      readVersion,
    ),
    ErrorCodes.NodeBinaryOutOfDate,
  );

export const invalidHitCondition = (expression: string) =>
  createUserError(
    localize(
      'invalidHitCondition',
      'Invalid hit condition "{0}". Expected an expression like "> 42" or "== 2".',
      expression,
    ),
    ErrorCodes.InvalidHitCondition,
  );

export const browserNotFound = (
  browserType: string,
  requested: string,
  available: ReadonlyArray<string>,
) =>
  createUserError(
    requested === 'stable' && !available.length
      ? localize(
          'noBrowserInstallFound',
          'Unable to find a {0} installation on your system. Try installing it, or providing an absolute path to the browser in the "runtimeExecutable" in your launch.json.',
          browserType,
        )
      : localize(
          'browserVersionNotFound',
          'Unable to find {0} version {1}. Available auto-discovered versions are: {2}. You can set the "runtimeExecutable" in your launch.json to one of these, or provide an absolute path to the browser executable.',
          browserType,
          requested,
          JSON.stringify([...new Set(available)]),
        ),
    ErrorCodes.BrowserNotFound,
  );

export const invalidLogPointSyntax = (error: string) =>
  createUserError(error, ErrorCodes.InvalidLogPointBreakpointSyntax);

export const asyncScopesNotAvailable = () =>
  createSilentError(
    localize(
      'asyncScopesNotAvailable',
      'Variables not available in async stacks',
      ErrorCodes.AsyncScopesNotAvailable,
    ),
  );

export class ProtocolError extends Error {
  public readonly cause: Dap.Message;

  constructor(cause: Dap.Message | Dap.Error) {
    super('__errorMarker' in cause ? cause.error.format : cause.format);
    this.cause = '__errorMarker' in cause ? cause.error : cause;
  }
}

/**
 * Returns if the value looks like a DAP error.
 */
export const isDapError = (value: unknown): value is Dap.Error =>
  typeof value === 'object' && !!value && '__errorMarker' in value;

/**
 * Use this error to fail a request with an error that came from user code or the runtime.
 * The original stack will be preserved, instead of attaching the stack from debug adapter code.
 */
export class ExternalError extends Error {
  __externalError = true;
}

export const isExternalError = (value: unknown): value is ExternalError =>
  typeof value === 'object' && !!value && '__externalError' in value;
