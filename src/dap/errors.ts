/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import Dap from './api';
import * as nls from 'vscode-nls';

const localize = nls.loadMessageBundle();

export const enum ErrorCodes {
  SilentError = 9222,
  UserError,
  NvmOrNvsNotFound,
  NvsNotFound,
  NvmHomeNotFound,
  CannotLaunchInTerminal,
  CannotLoadEnvironmentVariables,
  CannotFindNodeBinary,
  NodeBinaryOutOfDate,
  InvalidHitCondition,
  InvalidLogPointBreakpointSyntax,
  BrowserNotFound,
  AsyncScopesNotAvailable,
  ProfileCaptureError,
  InvalidConcurrentProfile,
  InvalidBreakpointCondition,
  ReplError,
  SourceMapParseFailed,
  BrowserLaunchFailed,
  TargetPageNotFound,
  BrowserAttachFailed,
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
      "Attribute 'runtimeVersion' requires Node.js version manager 'nvs' or 'nvm' to be installed.",
    ),
    ErrorCodes.NvmOrNvsNotFound,
  );

export const nvsNotFound = () =>
  createUserError(
    localize(
      'NVS_HOME.not.found.message',
      "Attribute 'runtimeVersion' with a flavor/architecture requires 'nvs' to be installed.",
    ),
    ErrorCodes.NvsNotFound,
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
      "Node.js version '{0}' not installed using version manager {1}.",
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

export const profileCaptureError = () =>
  createUserError(
    localize('profile.error.generic', 'An error occurred taking a profile from the target.'),
    ErrorCodes.ProfileCaptureError,
  );

export const invalidConcurrentProfile = () =>
  createUserError(
    localize(
      'profile.error.concurrent',
      'Please stop the running profile before starting a new one.',
    ),
    ErrorCodes.InvalidConcurrentProfile,
  );

export const replError = (message: string) => createSilentError(message, ErrorCodes.ReplError);

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

export const browserLaunchFailed = (innerError: Error) =>
  createUserError(
    localize('error.browserLaunchError', 'Unable to launch browser: "{0}"', innerError.message),
    ErrorCodes.BrowserLaunchFailed,
  );

export const browserAttachFailed = (message?: string) =>
  createUserError(
    message ?? localize('error.browserAttachError', 'Unable to attach to browser'),
    ErrorCodes.BrowserAttachFailed,
  );

export const targetPageNotFound = () =>
  createUserError(
    localize(
      'error.threadNotFound',
      'Target page not found. You may need to update your "urlFilter" to match the page you want to debug.',
    ),
    ErrorCodes.TargetPageNotFound,
  );

export const invalidLogPointSyntax = (error: string) =>
  createUserError(error, ErrorCodes.InvalidLogPointBreakpointSyntax);

export const asyncScopesNotAvailable = () =>
  createSilentError(
    localize('asyncScopesNotAvailable', 'Variables not available in async stacks'),
    ErrorCodes.AsyncScopesNotAvailable,
  );

export const invalidBreakPointCondition = (params: Dap.SourceBreakpoint, error: string) =>
  createUserError(
    localize(
      'breakpointSyntaxError',
      'Syntax error setting breakpoint with condition {0} on line {1}: {2}',
      JSON.stringify(params.condition),
      params.line,
      error,
    ),
    ErrorCodes.InvalidBreakpointCondition,
  );

// use the compiledUrl instead of the source map url here, since the source
// map could be a very large data URI
export const sourceMapParseFailed = (compiledUrl: string, message: string) =>
  createUserError(
    localize('sourcemapParseError', 'Could not read source map for {0}: {1}', compiledUrl, message),
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
