// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as DAP from './dap';
import { DebugProtocol } from 'vscode-debugprotocol';
import { CDPSession, SessionEvents } from './connection';
import { Target, TargetManager, TargetEvents } from './targetManager';
import { findChrome } from './findChrome';
import * as launcher from './launcher';
import Protocol from 'devtools-protocol';

export class Adapter implements DAP.Adapter {
	private _dap: DAP.Connection;
	private _browserSession: CDPSession;
	private _targetManager: TargetManager;
	private _mainTarget: Target;

	constructor(dap: DAP.Connection) {
		this._dap = dap;
		dap.setAdapter(this);
	}

	public async initialize(params: DebugProtocol.InitializeRequestArguments): Promise<DebugProtocol.Capabilities> {
		console.assert(params.linesStartAt1);
		console.assert(params.columnsStartAt1);
		console.assert(params.pathFormat === 'path');

		const executablePath = findChrome().pop();
		const connection = await launcher.launch(
			executablePath, {
				userDataDir: '.profile',
				pipe: true,
			});
		this._targetManager = new TargetManager(connection);
		this._targetManager.on(TargetEvents.TargetAttached, (target: Target) => {
			if (target.threadId())
        this._dap.didChangeThread('started', target.threadId());
		});
		this._targetManager.on(TargetEvents.TargetDetached, (target: Target) => {
			if (target.threadId())
        this._dap.didChangeThread('exited', target.threadId());
		});

		this._browserSession = connection.browserSession();
		this._browserSession.on(SessionEvents.Disconnected, () => this._dap.didExit(0));

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
		this._mainTarget = this._targetManager.mainTarget();
		if (!this._mainTarget)
		  this._mainTarget = await new Promise(f => this._targetManager.once(TargetEvents.TargetAttached, f));
		this._targetManager.on(TargetEvents.TargetDetached, (target: Target) => {
      if (target === this._mainTarget) {
				this._dap.didTerminate();
			}
		});
		await this._mainTarget.session().send('Page.navigate', {url: (params as {url:string}).url});
	}

	async getThreads(): Promise<DebugProtocol.Thread[]> {
		return this._targetManager.threadTargets().map(target => {
			return {
				id: target.threadId(),
				name: target.threadName(),
			}
		});
	}

	async getStackTrace(params: DebugProtocol.StackTraceArguments): Promise<DAP.StackTraceResult> {
		return {stackFrames: [], totalFrames: 0};
	}

	async getScopes(params: DebugProtocol.ScopesArguments): Promise<DebugProtocol.Scope[]> {
		return [];
	}

	async getVariables(params: DebugProtocol.VariablesArguments): Promise<DebugProtocol.Variable[]> {
		return [];
	}

	async continue(params: DebugProtocol.ContinueArguments): Promise<void> {
	}

	async evaluate(args: DebugProtocol.EvaluateArguments): Promise<DAP.EvaluateResult> {
		if (!this._mainTarget)
			return {result: '', variablesReference: 0};
		const params: Protocol.Runtime.EvaluateRequest = {
      expression: args.expression
		};
		const result = await this._mainTarget.session().send('Runtime.evaluate', params) as Protocol.Runtime.EvaluateResponse;
		return { result: result.result.description, variablesReference: 0 };
	}
}
