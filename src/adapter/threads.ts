/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import Cdp from '../cdp/api';
import * as debug from 'debug';
import {Source, Location, SourceContainer} from './sources';
import * as utils from '../utils';
import {StackTrace, StackFrame} from './stackTrace';
import * as objectPreview from './objectPreview';
import { VariableStore, VariableStoreDelegate } from './variables';
import Dap from '../dap/api';
import customBreakpoints from './customBreakpoints';
import * as nls from 'vscode-nls';
import * as messageFormat from './messageFormat';
import * as path from 'path';
import * as vscode from 'vscode';

const localize = nls.loadMessageBundle();
const debugThread = debug('thread');

export type PausedReason = 'step' | 'breakpoint' | 'exception' | 'pause' | 'entry' | 'goto' | 'function breakpoint' | 'data breakpoint';

export interface PausedDetails {
  reason: PausedReason;
  description: string;
  stackTrace: StackTrace;
  text?: string;
  exception?: Cdp.Runtime.RemoteObject;
}

export type PauseOnExceptionsState = 'none' | 'uncaught' | 'all';

export interface ExecutionContextTree {
  contextId?: number;
  name: string;
  threadId: number;
  children: ExecutionContextTree[];
}

export type Script = {scriptId: string, source: Source, thread: Thread};

let lastThreadId = 0;

export interface ThreadCapabilities {
  supportsCustomBreakpoints?: boolean
}

export interface ThreadTree {
  thread: Thread;
  children: ThreadTree[];
}

export interface ThreadManagerDelegate {
  threadForest(): ThreadTree[] | undefined;
  executionContextForest(): ExecutionContextTree[] | undefined;
}

export type ScriptWithSourceMapHandler = (script: Script, sources: Source[]) => Promise<void>;

export class ThreadManager {
  private _pauseOnExceptionsState: PauseOnExceptionsState;
  private _customBreakpoints: Set<string>;
  private _threads: Map<number, Thread> = new Map();
  private _dap: Dap.Api;

  _onThreadInitializedEmitter = new vscode.EventEmitter<Thread>();
  private _onThreadRemovedEmitter = new vscode.EventEmitter<Thread>();
  private _onExecutionContextsChangedEmitter = new vscode.EventEmitter<ExecutionContextTree[]>();
  readonly onThreadInitialized = this._onThreadInitializedEmitter.event;
  readonly onThreadRemoved = this._onThreadRemovedEmitter.event;
  readonly onExecutionContextsChanged = this._onExecutionContextsChangedEmitter.event;
  readonly sourceContainer: SourceContainer;
  private _delegate: ThreadManagerDelegate;
  private _defaultDelegate: DefaultThreadManagerDelegate;
  _scriptWithSourceMapHandler?: ScriptWithSourceMapHandler;

  constructor(dap: Dap.Api, sourceContainer: SourceContainer) {
    this._dap = dap;
    this._pauseOnExceptionsState = 'none';
    this._customBreakpoints = new Set();
    this.sourceContainer = sourceContainer;
    this._defaultDelegate = new DefaultThreadManagerDelegate(this);
    this._delegate = this._defaultDelegate;
  }

  mainThread(): Thread | undefined {
    return this._threads.values().next().value;
  }

  createThread(cdp: Cdp.Api, userData: any, capabilities: ThreadCapabilities): Thread {
    return new Thread(this, cdp, this._dap, capabilities, userData);
  }

  setDelegate(delegate: ThreadManagerDelegate) {
    this._delegate = delegate;
  }

  setScriptSourceMapHandler(handler?: ScriptWithSourceMapHandler) {
    this._scriptWithSourceMapHandler = handler;
  }

  _addThread(thread: Thread) {
    console.assert(!this._threads.has(thread.threadId()));
    this._threads.set(thread.threadId(), thread);
  }

  _removeThread(threadId: number) {
    const thread = this._threads.get(threadId);
    console.assert(thread);
    this._threads.delete(threadId);
    this._onThreadRemovedEmitter.fire(thread);
  }

  refreshExecutionContexts() {
    this._onExecutionContextsChangedEmitter.fire(this._delegate.executionContextForest() || this._defaultDelegate.executionContextForest());
  }

  refreshStackTraces(): boolean {
    let refreshed = false;
    for (const thread of this.threads()) {
      if (thread.pausedDetails()) {
        thread._reportResumed();
        thread._reportPaused();
        refreshed = true;
      }
    }
    return refreshed;
  }

  threads(): Thread[] {
    return Array.from(this._threads.values());
  }

  thread(threadId: number): Thread | undefined {
    return this._threads.get(threadId);
  }

  threadForest(): ThreadTree[] {
    return this._delegate.threadForest() || this._defaultDelegate.threadForest();
  }

  disposeAllThreads() {
    lastThreadId = 0;
    for (const thread of this.threads())
      thread.dispose();
    this.refreshExecutionContexts();
  }

  pauseOnExceptionsState(): PauseOnExceptionsState {
    return this._pauseOnExceptionsState;
  }

  setPauseOnExceptionsState(state: PauseOnExceptionsState) {
    this._pauseOnExceptionsState = state;
    for (const thread of this._threads.values())
      thread.updatePauseOnExceptionsState();
  }

  updateCustomBreakpoints(breakpoints: Dap.CustomBreakpoint[]): Promise<any> {
    const promises: Promise<boolean>[] = [];
    for (const breakpoint of breakpoints) {
      if (breakpoint.enabled && !this._customBreakpoints.has(breakpoint.id)) {
        this._customBreakpoints.add(breakpoint.id);
        for (const thread of this._threads.values())
          promises.push(thread.updateCustomBreakpoint(breakpoint.id, true));
      } else if (!breakpoint.enabled && this._customBreakpoints.has(breakpoint.id)) {
        this._customBreakpoints.delete(breakpoint.id);
        for (const thread of this._threads.values())
          promises.push(thread.updateCustomBreakpoint(breakpoint.id, false));
      }
    }
    return Promise.all(promises);
  }

  customBreakpoints(): Set<string> {
    return this._customBreakpoints;
  }

  scriptsFromSource(source: Source): Set<Script> {
    return source[kScriptsSymbol] || new Set();
  }
}

export class Thread implements VariableStoreDelegate {
  private _dap: Dap.Api;
  private _cdp: Cdp.Api;
  private _disposed = false;
  private _threadId: number;
  private _name: string;
  private _threadBaseUrl: string;
  private _pausedDetails?: PausedDetails;
  private _pausedVariables?: VariableStore;
  private _pausedForSourceMapScriptId?: string;
  private _scripts: Map<string, Script> = new Map();
  private _supportsCustomBreakpoints: boolean;
  private _executionContexts: Map<number, Cdp.Runtime.ExecutionContextDescription> = new Map();
  readonly replVariables: VariableStore;
  readonly manager: ThreadManager;
  readonly sourceContainer: SourceContainer;
  private _eventListeners: utils.Listener[] = [];
  private _userData: any;
  private _supportsSourceMapPause = false;
  private _defaultContextDestroyed: boolean;
  private _serializedOutput: Promise<void>;

  constructor(manager: ThreadManager, cdp: Cdp.Api, dap: Dap.Api, capabilities: ThreadCapabilities, userData: any) {
    this.manager = manager;
    this.sourceContainer = manager.sourceContainer;
    this._cdp = cdp;
    this._dap = dap;
    this._userData = userData;
    this._threadId = ++lastThreadId;
    this._name = '';
    this._supportsCustomBreakpoints = capabilities.supportsCustomBreakpoints || false;
    this.replVariables = new VariableStore(this._cdp, this);
    this.manager._addThread(this);
    this._serializedOutput = Promise.resolve();
    debugThread(`Thread created #${this._threadId}`);
  }

  cdp(): Cdp.Api {
    return this._cdp;
  }

  threadId(): number {
    return this._threadId;
  }

  name(): string {
    return this._name;
  }

  userData(): any {
    return this._userData;
  }

  pausedDetails(): PausedDetails | undefined {
    return this._pausedDetails;
  }

  pausedVariables(): VariableStore | undefined {
    return this._pausedVariables;
  }

  executionContexts(): Cdp.Runtime.ExecutionContextDescription[] {
    return Array.from(this._executionContexts.values());
  }

  defaultExecutionContext() : Cdp.Runtime.ExecutionContextDescription | undefined {
    for (const context of this._executionContexts.values()) {
      if (context.auxData && context.auxData['isDefault'])
        return context;
    }
  }

  supportsSourceMapPause() {
    return this._supportsSourceMapPause;
  }

  async resume(): Promise<boolean> {
    return !!await this._cdp.Debugger.resume({});
  }

  async pause(): Promise<boolean> {
    return !!await this._cdp.Debugger.pause({});
  }

  async stepOver(): Promise<boolean> {
    return !!await this._cdp.Debugger.stepOver({});
  }

  async stepInto(): Promise<boolean> {
    return !!await this._cdp.Debugger.stepInto({});
  }

  async stepOut(): Promise<boolean> {
    return !!await this._cdp.Debugger.stepOut({});
  }

  async restartFrame(stackFrame: StackFrame): Promise<boolean> {
    const callFrameId = stackFrame.callFrameId();
    if (!callFrameId)
      return false;
    const response = await this._cdp.Debugger.restartFrame({callFrameId});
    if (!response || !this._pausedDetails)
      return false;
    this._pausedDetails.stackTrace = StackTrace.fromDebugger(this, response.callFrames, response.asyncStackTrace, response.asyncStackTraceId);
    return true;
  }

  async initialize() {
    this._cdp.Runtime.on('executionContextCreated', event => {
      this._executionContextCreated(event.context);
    });
    this._cdp.Runtime.on('executionContextDestroyed', event => {
      this._executionContextDestroyed(event.executionContextId);
    });
    this._cdp.Runtime.on('executionContextsCleared', () => {
      this.output(this._clearDebuggerConsole());
      this.replVariables.clear();
      this._executionContextsCleared();
    });
    this._cdp.Runtime.on('consoleAPICalled', event => {
      this.output(this._onConsoleMessage(event));
    });
    this._cdp.Runtime.on('exceptionThrown', event => {
      this.output(this._onExceptionThrown(event.exceptionDetails));
    });
    this._cdp.Runtime.on('inspectRequested', event => {
      this._revealObject(event.object);
    });
    await this._cdp.Runtime.enable({});

    this._cdp.Debugger.on('paused', event => {
      if (event.reason === 'instrumentation' && event.data && event.data['scriptId']) {
        this._handleSourceMapPause(event.data['scriptId'] as string);
        return;
      }
      this._pausedDetails = this._createPausedDetails(event);
      this._pausedVariables = new VariableStore(this._cdp, this);
      this._reportPaused();
    });
    this._cdp.Debugger.on('resumed', () => this._onResumed());

    this._cdp.Debugger.on('scriptParsed', event => this._onScriptParsed(event));

    await this._cdp.Debugger.enable({});
    await this._cdp.Debugger.setAsyncCallStackDepth({maxDepth: 32});
    // We ignore the result to support older versions.
    this._supportsSourceMapPause =
        !!await this._cdp.Debugger.setInstrumentationBreakpoint({instrumentation: 'beforeScriptWithSourceMapExecution'});
    await this.updatePauseOnExceptionsState();

    const customBreakpointPromises: Promise<boolean>[] = [];
    for (const id of this.manager.customBreakpoints())
      customBreakpointPromises.push(this.updateCustomBreakpoint(id, true));
    // Do not fail for custom breakpoints not set, to account for
    // future changes in cdp vs stale breakpoints saved in the workspace.
    await Promise.all(customBreakpointPromises);

    if (this._disposed)
      return;

    this.manager._onThreadInitializedEmitter.fire(this);
    this._dap.thread({reason: 'started', threadId: this._threadId});
    if (this._pausedDetails)
      this._reportPaused();
  }

  async output(producer?: Promise<Dap.OutputEventParams | undefined>): Promise<void> {
    // TODO(dgozman): add timeout.
    this._serializedOutput = this._serializedOutput.then(async () => {
      const payload = await producer;
      if (payload)
        this._dap.output(payload);
    });
    return this._serializedOutput;
  }

  _executionContextCreated(context: Cdp.Runtime.ExecutionContextDescription) {
    this._executionContexts.set(context.id, context);
    this.manager.refreshExecutionContexts();
  }

  _executionContextDestroyed(contextId: number) {
    const context = this._executionContexts.get(contextId);
    if (!context)
      return;
    if (context.auxData && context.auxData['isDefault'])
      this._defaultContextDestroyed = true;
    this._executionContexts.delete(contextId);
    this.manager.refreshExecutionContexts();
  }

  defaultContextDestroyed(): boolean {
    return this._defaultContextDestroyed || false;
  }

  _executionContextsCleared() {
    this._removeAllScripts();
    if (this._pausedDetails)
      this._onResumed();
    this._executionContexts.clear();
    this.manager.refreshExecutionContexts();
  }

  _onResumed() {
    this._pausedDetails = undefined;
    this._pausedVariables = undefined;
    this._reportResumed();
  }

  async dispose() {
    this._removeAllScripts();
    this.manager._removeThread(this._threadId);
    this._dap.thread({reason: 'exited', threadId: this._threadId});
    utils.removeEventListeners(this._eventListeners);
    this._disposed = true;
    this._executionContextsCleared();
    debugThread(`Thread destroyed #${this._threadId}: ${this._name}`);
  }

  setName(name: string) {
    this._name = name;
  }

  setBaseUrl(threadUrl: string) {
    this._threadBaseUrl = threadUrl;
  }

  locationFromDebuggerCallFrame(callFrame: Cdp.Debugger.CallFrame): Location {
    const script = this._scripts.get(callFrame.location.scriptId);
    return {
      url: callFrame.url,
      lineNumber: callFrame.location.lineNumber,
      columnNumber: callFrame.location.columnNumber || 0,
      source: script ? script.source : undefined
    };
  }

  locationFromRuntimeCallFrame(callFrame: Cdp.Runtime.CallFrame): Location {
    const script = this._scripts.get(callFrame.scriptId);
    return {
      url: callFrame.url,
      lineNumber: callFrame.lineNumber,
      columnNumber: callFrame.columnNumber,
      source: script ? script.source : undefined
    };
  }

  locationFromDebugger(location: Cdp.Debugger.Location): Location {
    const script = this._scripts.get(location.scriptId);
    return {
      url: script ? script.source.url() : '',
      lineNumber: location.lineNumber,
      columnNumber: location.columnNumber || 0,
      source: script ? script.source : undefined
    };
  }

  async renderDebuggerLocation(loc: Cdp.Debugger.Location): Promise<string> {
    const location = this.sourceContainer.uiLocation(this.locationFromDebugger(loc));
    let path: string | undefined;
    if (location.source)
      path = await location.source.absolutePath();
    if (!path)
      path = location.url;
    return `@ ${path}:${location.lineNumber}`;
  }

  async updatePauseOnExceptionsState(): Promise<boolean> {
    return !!await this._cdp.Debugger.setPauseOnExceptions({state: this.manager.pauseOnExceptionsState()});
  }

  async updateCustomBreakpoint(id: string, enabled: boolean): Promise<boolean> {
    if (!this._supportsCustomBreakpoints)
      return true;
    const breakpoint = customBreakpoints().get(id);
    if (!breakpoint)
      return false;
    return breakpoint.apply(this._cdp, enabled);
  }

  _reportResumed() {
    this._dap.continued({threadId: this._threadId, allThreadsContinued: false });
  }

  _reportPaused(preserveFocusHint?: boolean) {
    const details = this._pausedDetails!;
    this._dap.stopped({
      reason: details.reason,
      description: details.description,
      threadId: this._threadId,
      text: details.text,
      preserveFocusHint,
      allThreadsStopped: false
    });
  }

  _createPausedDetails(event: Cdp.Debugger.PausedEvent): PausedDetails {
    const stackTrace = StackTrace.fromDebugger(this, event.callFrames, event.asyncStackTrace, event.asyncStackTraceId);
    switch (event.reason) {
      case 'assert': return {
        stackTrace,
        reason: 'exception',
        description: localize('pause.assert', 'Paused on assert')
      };
      case 'debugCommand': return {
        stackTrace,
        reason: 'pause',
        description: localize('pause.debugCommand', 'Paused on debug() call')
      };
      case 'DOM': return {
        stackTrace,
        reason: 'data breakpoint',
        description: localize('pause.DomBreakpoint', 'Paused on DOM breakpoint')
      };
      case 'EventListener': return this._resolveEventListenerBreakpointDetails(stackTrace, event);
      case 'exception': return {
        stackTrace,
        reason: 'exception',
        description: localize('pause.exception', 'Paused on exception'),
        exception: event.data as (Cdp.Runtime.RemoteObject | undefined)
      };
      case 'promiseRejection': return {
        stackTrace,
        reason: 'exception',
        description: localize('pause.promiseRejection', 'Paused on promise rejection')
      };
      case 'instrumentation': return {
        stackTrace,
        reason: 'function breakpoint',
        description: localize('pause.instrumentation', 'Paused on instrumentation breakpoint')
      };
      case 'XHR': return {
        stackTrace,
        reason: 'data breakpoint',
        description: localize('pause.xhr', 'Paused on XMLHttpRequest or fetch')
      };
      case 'OOM': return {
        stackTrace,
        reason: 'exception',
        description: localize('pause.oom', 'Paused before Out Of Memory exception')
      };
      default:
        if (event.hitBreakpoints && event.hitBreakpoints.length)  return {
          stackTrace,
          reason: 'breakpoint',
          description: localize('pause.breakpoint', 'Paused on breakpoint')
        };
        return {
          stackTrace,
          reason: 'step',
          description: localize('pause.default', 'Paused')
        };
    }
  }

  _resolveEventListenerBreakpointDetails(stackTrace: StackTrace, event: Cdp.Debugger.PausedEvent): PausedDetails {
    const data = event.data;
    const id = data ? (data['eventName'] || '') : '';
    const breakpoint = customBreakpoints().get(id);
    if (breakpoint) {
      const details = breakpoint.details(data!);
      return {stackTrace, reason: 'function breakpoint', description: details.short, text: details.long};
    }
    return {stackTrace, reason: 'function breakpoint', description: localize('pause.eventListener', 'Paused on event listener')};
  }

  async _onConsoleMessage(event: Cdp.Runtime.ConsoleAPICalledEvent): Promise<Dap.OutputEventParams | undefined> {
    switch (event.type) {
      case 'endGroup': return;
      case 'clear': return this._clearDebuggerConsole();
    }

    let stackTrace: StackTrace | undefined;
    let uiLocation: Location | undefined;
    if (event.stackTrace) {
      stackTrace = StackTrace.fromRuntime(this, event.stackTrace);
      const frames = await stackTrace.loadFrames(1);
      if (frames.length)
        uiLocation = this.sourceContainer.uiLocation(frames[0].uiLocation());
      if (event.type !== 'error' && event.type !== 'warning')
        stackTrace = undefined;
    }

    let category: 'console' | 'stdout' | 'stderr' | 'telemetry' = 'stdout';
    if (event.type === 'error')
      category = 'stderr';
    if (event.type === 'warning')
      category = 'console';

    const useMessageFormat = event.args.length > 1 && event.args[0].type === 'string';
    const formatString = useMessageFormat ? event.args[0].value as string : '';
    const messageText = messageFormat.formatMessage(formatString, useMessageFormat ? event.args.slice(1) : event.args, objectPreview.messageFormatters);
    const variablesReference = await this.replVariables.createVariableForOutput(messageText + '\n', event.args, stackTrace);
    return {
      category,
      output: '',
      variablesReference,
      source: uiLocation && uiLocation.source ? await uiLocation.source.toDap() : undefined,
      line: uiLocation ? uiLocation.lineNumber : undefined,
      column: uiLocation ? uiLocation.columnNumber : undefined,
    };
  }

  _clearDebuggerConsole(): Promise<Dap.OutputEventParams> {
    return Promise.resolve({
      category: 'console',
      output: '\x1b[2J',
    });
  }

  async _onExceptionThrown(details: Cdp.Runtime.ExceptionDetails): Promise<Dap.OutputEventParams | undefined> {
    const preview = details.exception ? objectPreview.previewException(details.exception) : {title: ''};
    let message = preview.title;
    if (!message.startsWith('Uncaught'))
      message = 'Uncaught ' + message;

    let stackTrace: StackTrace | undefined;
    let uiLocation: Location | undefined;
    if (details.stackTrace)
      stackTrace = StackTrace.fromRuntime(this, details.stackTrace);
    if (stackTrace) {
      const frames = await stackTrace.loadFrames(1);
      if (frames.length)
        uiLocation = this.sourceContainer.uiLocation(frames[0].uiLocation());
    }

    const args = (details.exception && !preview.stackTrace) ? [details.exception] : [];
    let variablesReference = 0;
    if (stackTrace || args.length)
      variablesReference = await this.replVariables.createVariableForOutput(message, args, stackTrace);

    return {
      category: 'stderr',
      output: message,
      variablesReference,
      source: (uiLocation && uiLocation.source) ? await uiLocation.source.toDap() : undefined,
      line: uiLocation ? uiLocation.lineNumber : undefined,
      column: uiLocation ? uiLocation.columnNumber : undefined,
    };
  }

  _removeAllScripts() {
    const scripts = Array.from(this._scripts.values());
    this._scripts.clear();
    for (const script of scripts) {
      const set = script.source[kScriptsSymbol];
      set.delete(script);
      if (!set.size)
        this.sourceContainer.removeSource(script.source);
    }
  }

  _onScriptParsed(event: Cdp.Debugger.ScriptParsedEvent) {
    if (!this.sourceContainer.initialized())
      return;

    let source = event.url ? this.sourceContainer.sourceByUrl(event.url) : undefined;
    if (!source) {
      const contentGetter = async () => {
        const response = await this._cdp.Debugger.getScriptSource({scriptId: event.scriptId});
        return response ? response.scriptSource : undefined;
      };
      const inlineSourceRange = (event.startLine || event.startColumn)
          ? {startLine: event.startLine, startColumn: event.startColumn, endLine: event.endLine, endColumn: event.endColumn}
          : undefined;
      let resolvedSourceMapUrl: string | undefined;
      if (event.sourceMapURL) {
        // TODO(dgozman): reload source map when thread url changes.
        const resolvedSourceUrl = utils.completeUrl(this._threadBaseUrl, event.url);
        resolvedSourceMapUrl = resolvedSourceUrl && utils.completeUrl(resolvedSourceUrl, event.sourceMapURL);
      }
      source = this.sourceContainer.addSource(event.url, contentGetter, resolvedSourceMapUrl, inlineSourceRange);
    }

    const script = {scriptId: event.scriptId, source, thread: this};
    this._scripts.set(event.scriptId, script);
    if (!source[kScriptsSymbol])
      source[kScriptsSymbol] = new Set();
    source[kScriptsSymbol].add(script);
  }

  async _handleSourceMapPause(scriptId: string) {
    this._pausedForSourceMapScriptId = scriptId;
    const script = this._scripts.get(scriptId);
    if (script) {
      const sources = await this.sourceContainer.waitForSourceMapSources(script.source);
      if (sources && this.manager._scriptWithSourceMapHandler)
        this.manager._scriptWithSourceMapHandler(script, sources);
    }
    if (this._pausedForSourceMapScriptId === scriptId) {
      this._pausedForSourceMapScriptId = undefined;
      this._cdp.Debugger.resume({});
    }
  }

  async _revealObject(object: Cdp.Runtime.RemoteObject) {
    if (object.type !== 'function')
      return;
    const response = await this._cdp.Runtime.getProperties({
      objectId: object.objectId!,
      ownProperties: true
    });
    if (!response)
      return;
    for (const p of response.internalProperties || []) {
      if (p.name !== '[[FunctionLocation]]' || !p.value || p.value.subtype as string !== 'internal#location')
        continue;
      const loc = p.value.value as Cdp.Debugger.Location;
      const uiLocation = this.sourceContainer.uiLocation(this.locationFromDebugger(loc));
      this.sourceContainer.revealLocation(uiLocation);
      break;
    }
  }
};

export class DefaultThreadManagerDelegate implements ThreadManagerDelegate {
  private _manager: ThreadManager;

  constructor(manager: ThreadManager) {
    this._manager = manager;
  }

  threadForest(): ThreadTree[] {
    return this._manager.threads().map(thread => {
      return {
        thread,
        children: []
      }
    });
  }

  executionContextForest(): ExecutionContextTree[] {
    const result: ExecutionContextTree[] = [];
    for (const thread of this._manager.threads()) {
      const threadContext: ExecutionContextTree = {
        name: thread.name() || `thread #${thread.threadId()}`,
        threadId: thread.threadId(),
        children: [],
      };
      result.push(threadContext);
      threadContext.children = thread.executionContexts().map(context => {
        return {
          name: context.name || `context #${context.id}`,
          threadId: thread.threadId(),
          contextId: context.id,
          children: [],
        };
      });
    }
    return result;
  }
}

const kScriptsSymbol = Symbol('script');
