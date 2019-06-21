import * as DAP from './dap';
import { DebugProtocol } from 'vscode-debugprotocol';
import { CDPSession, SessionEvents } from './connection';
import { TargetManager, TargetEvents } from './targetManager';
import { findChrome } from './findChrome';
import * as launcher from './launcher';

export class Adapter implements DAP.Adapter {
	private _dap: DAP.Connection;
	private _browserSession: CDPSession;
	private _targetManager: TargetManager;

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
		this._targetManager.on(TargetEvents.TargetAttached, target => {
			if (target.threadId())
        this._dap.didChangeThread('started', target.threadId());
		});
		this._targetManager.on(TargetEvents.TargetDetached, target => {
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
		let target = this._targetManager.mainTarget();
		if (!target)
			target = await new Promise(f => this._targetManager.once(TargetEvents.TargetAttached, f));
		this._targetManager.on(TargetEvents.TargetDetached, t => {
      if (t === target) {
				this._dap.didTerminate();
			}
		});
		await target.session().send('Page.navigate', {url: (params as {url:string}).url});
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

	async evaluate(params: DebugProtocol.EvaluateArguments): Promise<DAP.EvaluateResult> {
		return {result: '', variablesReference: 0};
	}
}
