/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as nls from 'vscode-nls';
import Dap from '../dap/api';
import { generateBreakpointId } from './breakpoints';
import { PauseOnExceptionsState } from './threads';

const localize = nls.loadMessageBundle();

export type SetBreakpointRequest = {
  params: Dap.SetBreakpointsParams;
  generatedIds: number[];
};

export class Configurator {
  private _setBreakpointRequests: SetBreakpointRequest[] = [];
  private _pausedOnExceptionsState: PauseOnExceptionsState = 'none';

  constructor(dap: Dap.Api) {
    dap.on('setBreakpoints', params => this._onSetBreakpoints(params));
    dap.on('setExceptionBreakpoints', params => this._onSetExceptionBreakpoints(params));
    dap.on('configurationDone', params => this._onConfigurationDone(params));
  }

  capabilities(): Dap.InitializeResult {
    return {
      supportsConfigurationDoneRequest: true,
      supportsFunctionBreakpoints: false,
      supportsConditionalBreakpoints: true,
      supportsHitConditionalBreakpoints: false,
      supportsEvaluateForHovers: true,
      exceptionBreakpointFilters: [
        { filter: 'caught', label: localize('breakpoint.caughtExceptions', 'Caught Exceptions'), default: false },
        { filter: 'uncaught', label: localize('breakpoint.uncaughtExceptions', 'Uncaught Exceptions'), default: false },
      ],
      supportsStepBack: false,
      supportsSetVariable: true,
      supportsRestartFrame: true,
      supportsGotoTargetsRequest: false,
      supportsStepInTargetsRequest: false,
      supportsCompletionsRequest: true,
      supportsModulesRequest: false,
      additionalModuleColumns: [],
      supportedChecksumAlgorithms: [],
      supportsRestartRequest: true,
      supportsExceptionOptions: false,
      supportsValueFormattingOptions: false,  // This is not used by vscode.
      supportsExceptionInfoRequest: true,
      supportTerminateDebuggee: false,
      supportsDelayedStackTraceLoading: true,
      supportsLoadedSourcesRequest: true,
      supportsLogPoints: true,
      supportsTerminateThreadsRequest: false,
      supportsSetExpression: false,
      supportsTerminateRequest: false,
      //supportsDataBreakpoints: false,
      //supportsReadMemoryRequest: false,
      //supportsDisassembleRequest: false,
    };
  }

  static resolvePausedOnExceptionsState(params: Dap.SetExceptionBreakpointsParams): PauseOnExceptionsState {
    if (params.filters.includes('caught'))
      return 'all';
    if (params.filters.includes('uncaught'))
      return 'uncaught';
    return 'none';
  }

  setBreakpointRequests(): SetBreakpointRequest[] {
    return this._setBreakpointRequests;
  }

  pausedOnExceptionsState(): PauseOnExceptionsState {
    return this._pausedOnExceptionsState;
  }

  async _onSetBreakpoints(params: Dap.SetBreakpointsParams): Promise<Dap.SetBreakpointsResult> {
    const request: SetBreakpointRequest = {
      params,
      generatedIds: []
    };
    this._setBreakpointRequests.push(request);
    const result: Dap.SetBreakpointsResult = { breakpoints: [] };
    for (const _ of params.breakpoints || []) {
      const id = generateBreakpointId();
      request.generatedIds.push(id);
      result.breakpoints.push({ id, verified: false });
    }
    return result;
  }

  async _onSetExceptionBreakpoints(params: Dap.SetExceptionBreakpointsParams): Promise<Dap.SetExceptionBreakpointsResult> {
    this._pausedOnExceptionsState = Configurator.resolvePausedOnExceptionsState(params);
    return {};
  }

  async _onConfigurationDone(_: Dap.ConfigurationDoneParams): Promise<Dap.ConfigurationDoneResult> {
    return {};
  }
}
