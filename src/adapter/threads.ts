// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import Cdp from '../cdp/api';
import * as debug from 'debug';
import {Source, Location, SourceContainer} from './sources';
import * as utils from '../utils';
import {StackTrace, StackFrame} from './stackTrace';
import * as objectPreview from './objectPreview';
import { VariableStore } from './variables';
import Dap from '../dap/api';
import customBreakpoints from './customBreakpoints';
import * as nls from 'vscode-nls';
import * as messageFormat from './messageFormat';
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
  threadForest(threads: Thread[]): ThreadTree[];
  executionContextForest(threads: Thread[]): ExecutionContextTree[];
}

export class ThreadManager {
  private _pauseOnExceptionsState: PauseOnExceptionsState;
  private _customBreakpoints: Set<string>;
  private _threads: Map<number, Thread> = new Map();
  private _dap: Dap.Api;

  _onThreadInitializedEmitter = new vscode.EventEmitter<Thread>();
  private _onThreadRemovedEmitter = new vscode.EventEmitter<Thread>();
  private _onExecutionContextsChangedEmitter = new vscode.EventEmitter<ExecutionContextTree[]>();
  _onScriptWithSourceMapLoadedEmitter = new vscode.EventEmitter<{script: Script, sources: Source[]}>();
  readonly onThreadInitialized = this._onThreadInitializedEmitter.event;
  readonly onThreadRemoved = this._onThreadRemovedEmitter.event;
  readonly onExecutionContextsChanged = this._onExecutionContextsChangedEmitter.event;
  readonly onScriptWithSourceMapLoaded = this._onScriptWithSourceMapLoadedEmitter.event;
  readonly sourceContainer: SourceContainer;
  private _delegate: ThreadManagerDelegate;

  constructor(dap: Dap.Api, sourceContainer: SourceContainer) {
    this._dap = dap;
    this._pauseOnExceptionsState = 'none';
    this._customBreakpoints = new Set();
    this.sourceContainer = sourceContainer;
    this._delegate = new DefaultThreadManagerDelegate();
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
    this._onExecutionContextsChangedEmitter.fire(this._delegate.executionContextForest(this.threads()));
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

export class Thread {
  private _dap: Dap.Api;
  private _cdp: Cdp.Api;
  private _disposed = false;
  private _threadId: number;
  private _name: string;
  private _threadBaseUrl: string;
  private _pausedDetails: PausedDetails | null;
  private _pausedVariables: VariableStore | null = null;
  private _pausedForSourceMapScriptId?: string;
  private _scripts: Map<string, Script> = new Map();
  private _supportsCustomBreakpoints: boolean;
  private _executionContexts: Map<number, Cdp.Runtime.ExecutionContextDescription> = new Map();
  readonly replVariables: VariableStore;
  readonly manager: ThreadManager;
  readonly sourceContainer: SourceContainer;
  private _eventListeners: utils.Listener[] = [];
  private _userData: any;

  constructor(manager: ThreadManager, cdp: Cdp.Api, dap: Dap.Api, capabilities: ThreadCapabilities, userData: any) {
    this.manager = manager;
    this.sourceContainer = manager.sourceContainer;
    this._cdp = cdp;
    this._dap = dap;
    this._userData = userData;
    this._threadId = ++lastThreadId;
    this._name = '';
    this._supportsCustomBreakpoints = capabilities.supportsCustomBreakpoints || false;
    this.replVariables = new VariableStore(this._cdp);
    this.manager._addThread(this);
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

  pausedDetails(): PausedDetails | null {
    return this._pausedDetails;
  }

  pausedVariables(): VariableStore | null {
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

  async restartFrame(callFrameId: Cdp.Debugger.CallFrameId): Promise<boolean> {
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
      this.replVariables.clear();
      this._clearDebuggerConsole();
      this._executionContextsCleared();
    });
    this._cdp.Runtime.on('consoleAPICalled', event => {
      this._onConsoleMessage(event);
    });
    this._cdp.Runtime.on('exceptionThrown', event => {
      this._onExceptionThrown(event.exceptionDetails);
    });
    await this._cdp.Runtime.enable({});

    this._cdp.Debugger.on('paused', event => {
      if (event.reason === 'instrumentation' && event.data && event.data['scriptId']) {
        this._handleSourceMapPause(event.data['scriptId'] as string);
        return;
      }
      this._pausedDetails = this._createPausedDetails(event);
      this._pausedVariables = new VariableStore(this._cdp);
      this._reportPaused();
    });
    this._cdp.Debugger.on('resumed', () => this._onResumed());

    this._cdp.Debugger.on('scriptParsed', event => this._onScriptParsed(event));

    await this._cdp.Debugger.enable({});
    await this._cdp.Debugger.setAsyncCallStackDepth({maxDepth: 32});
    // We ignore the result to support older versions.
    await this._cdp.Debugger.setInstrumentationBreakpoint({instrumentation: 'beforeScriptWithSourceMapExecution'});
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

  _executionContextCreated(context: Cdp.Runtime.ExecutionContextDescription) {
    this._executionContexts.set(context.id, context);
    this.manager.refreshExecutionContexts();
  }

  _executionContextDestroyed(contextId: number) {
    this._executionContexts.delete(contextId);
    this.manager.refreshExecutionContexts();
  }

  _executionContextsCleared() {
    this._removeAllScripts();
    if (this._pausedDetails)
      this._onResumed();
    this._executionContexts.clear();
    this.manager.refreshExecutionContexts();
  }

  _onResumed() {
    this._pausedDetails = null;
    this._pausedVariables = null;
    this._reportResumed();
  }

  async dispose() {
    this._executionContextsCleared();
    this._removeAllScripts();
    this.manager._removeThread(this._threadId);
    this._dap.thread({reason: 'exited', threadId: this._threadId});
    utils.removeEventListeners(this._eventListeners);
    this._disposed = true;
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
      default: return {
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

  async _onConsoleMessage(event: Cdp.Runtime.ConsoleAPICalledEvent): Promise<void> {
    switch (event.type) {
      case 'endGroup': return;
      case 'clear': this._clearDebuggerConsole(); return;
    }

    let stackTrace: StackTrace | undefined;
    let uiLocation: Location | undefined;
    if (event.stackTrace) {
      stackTrace = StackTrace.fromRuntime(this, event.stackTrace);
      const frames = await stackTrace.loadFrames(1);
      if (frames.length)
        uiLocation = this.sourceContainer.uiLocation(frames[0].location);
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

    const allPrimitive = !event.args.find(a => !!a.objectId);
    if (allPrimitive && !stackTrace) {
      this._dap.output({
        category,
        output: messageText + '\n',
        variablesReference: 0,
        source: uiLocation && uiLocation.source ? uiLocation.source.toDap() : undefined,
        line: uiLocation ? uiLocation.lineNumber : undefined,
        column: uiLocation ? uiLocation.columnNumber : undefined,
      });
      return;
    }

    const variablesReference = await this.replVariables.createVariableForMessageFormat(messageText + '\n', event.args, stackTrace);
    this._dap.output({
      category,
      output: '',
      variablesReference,
      source: uiLocation && uiLocation.source ? uiLocation.source.toDap() : undefined,
      line: uiLocation ? uiLocation.lineNumber : undefined,
      column: uiLocation ? uiLocation.columnNumber : undefined,
    });
  }

  _clearDebuggerConsole() {
    this._dap.output({
      category: 'console',
      output: '\x1b[2J',
    });
  }

  async _onExceptionThrown(details: Cdp.Runtime.ExceptionDetails): Promise<void> {
    let stackTrace: StackTrace | undefined;
    let uiLocation: Location | undefined;
    if (details.stackTrace)
      stackTrace = StackTrace.fromRuntime(this, details.stackTrace);
    const frames: StackFrame[] = stackTrace ? await stackTrace.loadFrames(50) : [];
    if (frames.length)
      uiLocation = this.sourceContainer.uiLocation(frames[0].location);
    const description = details.exception && details.exception.description || '';
    let message = description.split('\n').filter(line => !line.startsWith('    at')).join('\n');
    if (stackTrace)
      message += '\n' + (await stackTrace.format());
    this._dap.output({
      category: 'stderr',
      output: message,
      variablesReference: 0,
      line: uiLocation ? uiLocation.lineNumber : undefined,
      column: uiLocation ? uiLocation.columnNumber : undefined,
    });
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
      if (sources)
        this.manager._onScriptWithSourceMapLoadedEmitter.fire({script, sources});
    }
    if (this._pausedForSourceMapScriptId === scriptId) {
      this._pausedForSourceMapScriptId = undefined;
      this._cdp.Debugger.resume({});
    }
  }
};

export class DefaultThreadManagerDelegate implements ThreadManagerDelegate {
  threadForest(threads: Thread[]): ThreadTree[] {
    return threads.map(thread => {
      return {
        thread,
        children: []
      }
    });
  }

  executionContextForest(threads: Thread[]): ExecutionContextTree[] {
    const result: ExecutionContextTree[] = [];
    for (const thread of threads.values()) {
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
