// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as DAP from './dap';
import { DebugProtocol } from 'vscode-debugprotocol';

export class Adapter implements DAP.Adapter {
	private _dap: DAP.Connection;

	constructor(dap: DAP.Connection) {
		this._dap = dap;
		dap.setAdapter(this);
	}

	public async initialize(params: DebugProtocol.InitializeRequestArguments): Promise<DebugProtocol.Capabilities> {
		console.assert(params.linesStartAt1);
		console.assert(params.columnsStartAt1);
		console.assert(params.pathFormat === 'path');

		// params.locale || 'en-US'
		// params.supportsVariableType
		// params.supportsVariablePaging
		// params.supportsRunInTerminalRequest
		// params.supportsMemoryReferences

		this._dap.didInitialize();
		return {
			supportsConfigurationDoneRequest: false,
			supportsFunctionBreakpoints: false,
			supportsConditionalBreakpoints: false,
			supportsHitConditionalBreakpoints: false,
			supportsEvaluateForHovers: false,
			exceptionBreakpointFilters: [],
			supportsStepBack: false,
			supportsSetVariable: false,
			supportsRestartFrame: false,
			supportsGotoTargetsRequest: false,
			supportsStepInTargetsRequest: false,
			supportsCompletionsRequest: false,
			supportsModulesRequest: false,
			additionalModuleColumns: [],
			supportedChecksumAlgorithms: [],
			supportsRestartRequest: false,
			supportsExceptionOptions: false,
			supportsValueFormattingOptions: false,
			supportsExceptionInfoRequest: false,
			supportTerminateDebuggee: false,
			supportsDelayedStackTraceLoading: false,
			supportsLoadedSourcesRequest: false,
			supportsLogPoints: false,
			supportsTerminateThreadsRequest: false,
			supportsSetExpression: false,
			supportsTerminateRequest: false,
			//supportsDataBreakpoints: false,
			//supportsReadMemoryRequest: false,
			//supportsDisassembleRequest: false,
		};
	}

	async launch(params: DebugProtocol.LaunchRequestArguments): Promise<void> {
		// params.noDebug
		// params.url
		setTimeout(() => {
			this._dap.didPause('pause', 'Just paused', 1);
		}, 0);
	}

	async getThreads(): Promise<DebugProtocol.Thread[]> {
		return [{id: 1, name: 'Thread #1'}, {id: 2, name: 'Thread #2'}];
	}

	async getStackTrace(params: DebugProtocol.StackTraceArguments): Promise<{stackFrames: DebugProtocol.StackFrame[], totalFrames?: number}> {
		return {stackFrames: [], totalFrames: 0};
	}

	async getScopes(params: DebugProtocol.ScopesArguments): Promise<DebugProtocol.Scope[]> {
		return [];
	}

	async getVariables(params: DebugProtocol.VariablesArguments): Promise<DebugProtocol.Variable[]> {
		return [];
	}
}
