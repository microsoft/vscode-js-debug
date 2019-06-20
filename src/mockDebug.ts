// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
	Logger, logger,
	LoggingDebugSession,
	InitializedEvent,
	Thread, Scope
} from 'vscode-debugadapter';
import { DebugProtocol } from 'vscode-debugprotocol';
import { CDPSession } from './connection';
import { TargetManager } from './targetManager';
import { findChrome } from './findChrome';
import * as launcher from './launcher';


/**
 * This interface describes the mock-debug specific launch attributes
 * (which are not part of the Debug Adapter Protocol).
 * The schema for these attributes lives in the package.json of the mock-debug extension.
 * The interface should always match this schema.
 */
interface LaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
	/** An absolute path to the "program" to debug. */
	program: string;
	/** Automatically stop target after launch. If not specified, target does not stop. */
	stopOnEntry?: boolean;
	/** enable logging the Debug Adapter Protocol */
	trace?: boolean;
}

export class MockDebugSession extends LoggingDebugSession {

	// we don't support multiple threads, so we can use a hardcoded ID for the default thread
	private static THREAD_ID = 1;

	private _configurationDone: Function;
	private _browserSession: CDPSession;

	/**
	 * Creates a new debug adapter that is used for one debug session.
	 * We configure the default implementation of a debug adapter here.
	 */
	public constructor() {
		super("mock-debug.txt");

		// this debugger uses zero-based lines and columns
		this.setDebuggerLinesStartAt1(false);
		this.setDebuggerColumnsStartAt1(false);

		// this._runtime = new MockRuntime();

		// // setup event handlers
		// this._runtime.on('stopOnEntry', () => {
		// 	this.sendEvent(new StoppedEvent('entry', MockDebugSession.THREAD_ID));
		// });
		// this._runtime.on('stopOnStep', () => {
		// 	this.sendEvent(new StoppedEvent('step', MockDebugSession.THREAD_ID));
		// });
		// this._runtime.on('stopOnBreakpoint', () => {
		// 	this.sendEvent(new StoppedEvent('breakpoint', MockDebugSession.THREAD_ID));
		// });
		// this._runtime.on('stopOnException', () => {
		// 	this.sendEvent(new StoppedEvent('exception', MockDebugSession.THREAD_ID));
		// });
		// this._runtime.on('breakpointValidated', (bp: MockBreakpoint) => {
		// 	this.sendEvent(new BreakpointEvent('changed', <DebugProtocol.Breakpoint>{ verified: bp.verified, id: bp.id }));
		// });
		// this._runtime.on('output', (text, filePath, line, column) => {
		// 	const e: DebugProtocol.OutputEvent = new OutputEvent(`${text}\n`);
		// 	e.body.source = this.createSource(filePath);
		// 	e.body.line = this.convertDebuggerLineToClient(line);
		// 	e.body.column = this.convertDebuggerColumnToClient(column);
		// 	this.sendEvent(e);
		// });
		// this._runtime.on('end', async () => {
		// 	this.sendEvent(new TerminatedEvent());
		// });
	}

	protected dispatchRequest(request: DebugProtocol.Request) {
		console.log(request);
		return super.dispatchRequest(request);
	}

	/**
	 * The 'initialize' request is the first request called by the frontend
	 * to interrogate the features the debug adapter provides.
	 */
	protected async initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments) {
		// build and return the capabilities of this debug adapter:
		response.body = response.body || {};
		response.body.supportsConfigurationDoneRequest = true;
		response.body.supportsEvaluateForHovers = true;
		response.body.supportsRestartRequest = true;

		this.sendResponse(response);

		// start the program in the runtime
		const executablePath = findChrome().pop();
		const connection = await launcher.launch(
			executablePath, {
				userDataDir: '.profile',
				pipe: true,
			});
		new TargetManager(connection);
		this.sendEvent(new InitializedEvent());
	}

	/**
	 * Called at the end of the configuration sequence.
	 * Indicates that all breakpoints etc. have been sent to the DA and that the 'launch' can start.
	 */
	protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments): void {
		super.configurationDoneRequest(response, args);
		// notify the launchRequest that configuration has finished
		this._configurationDone();
	}

	protected async disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments) {
		await this._browserSession.send('Browser.close');
    this.sendResponse(response);
	}

	protected async launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchRequestArguments) {
		// make sure to 'Stop' the buffered logging if 'trace' is not set
		logger.setup(args.trace ? Logger.LogLevel.Verbose : Logger.LogLevel.Stop, false);
		await new Promise(f => this._configurationDone = f);
		this.sendResponse(response);
	}

	protected async terminateRequest(response: DebugProtocol.TerminateResponse, args: DebugProtocol.TerminateArguments) {
		await this._browserSession.send('Browser.close');
		this.sendResponse(response);
	}

	protected async restartRequest(response: DebugProtocol.RestartResponse, args: DebugProtocol.RestartArguments) {
		this.sendResponse(response);
	}

	protected setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): void {
		// const path = <string>args.source.path;
		// const clientLines = args.lines || [];

		// // clear all breakpoints for this file
		// this._runtime.clearBreakpoints(path);

		// // set and verify breakpoint locations
		// const actualBreakpoints = clientLines.map(l => {
		// 	let { verified, line, id } = this._runtime.setBreakPoint(path, this.convertClientLineToDebugger(l));
		// 	const bp = <DebugProtocol.Breakpoint> new Breakpoint(verified, this.convertDebuggerLineToClient(line));
		// 	bp.id= id;
		// 	return bp;
		// });

		// // send back the actual breakpoint positions
		response.body = {
			breakpoints: []
		};
		this.sendResponse(response);
	}

	protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
		// runtime supports now threads so just return a default thread.
		response.body = {
			threads: [
				new Thread(MockDebugSession.THREAD_ID, "thread 1")
			]
		};
		this.sendResponse(response);
	}

	protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): void {
		// const startFrame = typeof args.startFrame === 'number' ? args.startFrame : 0;
		// const maxLevels = typeof args.levels === 'number' ? args.levels : 1000;
		// const endFrame = startFrame + maxLevels;

		// const stk = this._runtime.stack(startFrame, endFrame);

		// response.body = {
		// 	stackFrames: stk.frames.map(f => new StackFrame(f.index, f.name, this.createSource(f.file), this.convertDebuggerLineToClient(f.line))),
		// 	totalFrames: stk.count
		// };
		this.sendResponse(response);
	}

	protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {
		// const frameReference = args.frameId;
		const scopes = new Array<Scope>();
		// scopes.push(new Scope("Local", this._variableHandles.create("local_" + frameReference), false));
		// scopes.push(new Scope("Global", this._variableHandles.create("global_" + frameReference), true));

		response.body = {
			scopes: scopes
		};
		this.sendResponse(response);
	}

	protected variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments): void {

		const variables = new Array<DebugProtocol.Variable>();
		// const id = this._variableHandles.get(args.variablesReference);
		// if (id !== null) {
		// 	variables.push({
		// 		name: id + "_i",
		// 		type: "integer",
		// 		value: "123",
		// 		variablesReference: 0
		// 	});
		// 	variables.push({
		// 		name: id + "_f",
		// 		type: "float",
		// 		value: "3.14",
		// 		variablesReference: 0
		// 	});
		// 	variables.push({
		// 		name: id + "_s",
		// 		type: "string",
		// 		value: "hello world",
		// 		variablesReference: 0
		// 	});
		// 	variables.push({
		// 		name: id + "_o",
		// 		type: "object",
		// 		value: "Object",
		// 		variablesReference: this._variableHandles.create("object_")
		// 	});
		// }

		response.body = {
			variables: variables
		};
		this.sendResponse(response);
	}

	protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {
		this.sendResponse(response);
	}

	protected reverseContinueRequest(response: DebugProtocol.ReverseContinueResponse, args: DebugProtocol.ReverseContinueArguments) : void {
		this.sendResponse(response);
 	}

	protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {
		this.sendResponse(response);
	}

	protected stepBackRequest(response: DebugProtocol.StepBackResponse, args: DebugProtocol.StepBackArguments): void {
		this.sendResponse(response);
	}

	protected evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): void {

		// let reply: string | undefined = undefined;

		// if (args.context === 'repl') {
		// 	// 'evaluate' supports to create and delete breakpoints from the 'repl':
		// 	const matches = /new +([0-9]+)/.exec(args.expression);
		// 	if (matches && matches.length === 2) {
		// 		const mbp = this._runtime.setBreakPoint(this._runtime.sourceFile, this.convertClientLineToDebugger(parseInt(matches[1])));
		// 		const bp = <DebugProtocol.Breakpoint> new Breakpoint(mbp.verified, this.convertDebuggerLineToClient(mbp.line), undefined, this.createSource(this._runtime.sourceFile));
		// 		bp.id= mbp.id;
		// 		this.sendEvent(new BreakpointEvent('new', bp));
		// 		reply = `breakpoint created`;
		// 	} else {
		// 		const matches = /del +([0-9]+)/.exec(args.expression);
		// 		if (matches && matches.length === 2) {
		// 			const mbp = this._runtime.clearBreakPoint(this._runtime.sourceFile, this.convertClientLineToDebugger(parseInt(matches[1])));
		// 			if (mbp) {
		// 				const bp = <DebugProtocol.Breakpoint> new Breakpoint(false);
		// 				bp.id= mbp.id;
		// 				this.sendEvent(new BreakpointEvent('removed', bp));
		// 				reply = `breakpoint deleted`;
		// 			}
		// 		}
		// 	}
		// }

		// response.body = {
		// 	result: reply ? reply : `evaluate(context: '${args.context}', '${args.expression}')`,
		// 	variablesReference: 0
		// };
		this.sendResponse(response);
	}

	//---- helpers

	// private createSource(filePath: string): Source {
	// 	return new Source(basename(filePath), this.convertDebuggerPathToClient(filePath), undefined, undefined, 'mock-adapter-data');
	// }
}
