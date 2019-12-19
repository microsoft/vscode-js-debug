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
