// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import Cdp from '../cdp/api';
import * as debug from 'debug';
import {Source, Location, SourceContainer} from './source';
import * as utils from '../utils';
import {StackTrace, StackFrame} from './stackTrace';
import * as objectPreview from './objectPreview';
import { VariableStore } from './variableStore';
import Dap from '../dap/api';
import { Target } from './targetManager';
import customBreakpoints from './customBreakpoints';
import * as nls from 'vscode-nls';

const localize = nls.loadMessageBundle();
const debugThread = debug('thread');

export type PausedReason = 'step' | 'breakpoint' | 'exception' | 'pause' | 'entry' | 'goto' | 'function breakpoint' | 'data breakpoint';

export interface PausedDetails {
  reason: PausedReason;
  description: string;
  stackTrace: StackTrace;
  text?: string;
  exception?: Cdp.Runtime.RemoteObject;
};

export class Thread {
  private static _lastThreadId: number = 0;

  private _dap: Dap.Api;
  private _sourceContainer: SourceContainer;
  private _cdp: Cdp.Api;
  private _state: ('init' | 'normal' | 'disposed') = 'init';
  private _threadId: number;
  private _threadName: string;
  private _threadNameWithIndentation: string;
  private _threadUrl: string;
  private _pausedDetails: PausedDetails | null;
  private _pausedVariables: VariableStore | null = null;
  private _scripts: Map<string, Source> = new Map();
  private _supportsCustomBreakpoints: boolean;
  private _executionContexts: Map<number, Cdp.Runtime.ExecutionContextDescription> = new Map();
  readonly target: Target;
  readonly replVariables: VariableStore;

  constructor(target: Target, sourceContainer: SourceContainer, cdp: Cdp.Api, dap: Dap.Api, supportsCustomBreakpoints: boolean) {
    this.target = target;
    this._sourceContainer = sourceContainer;
    this._cdp = cdp;
    this._dap = dap;
    this._threadId = ++Thread._lastThreadId;
    this._threadName = '';
    this._supportsCustomBreakpoints = supportsCustomBreakpoints;
    this.replVariables = new VariableStore(this._cdp);
    debugThread(`Thread created #${this._threadId}`);
  }

  cdp(): Cdp.Api {
    return this._cdp;
  }

  threadId(): number {
    return this._threadId;
  }

  threadName(): string {
    return this._threadName;
  }

  threadNameWithIndentation(): string {
    return this._threadNameWithIndentation;
  }

  pausedDetails(): PausedDetails | null {
    return this._pausedDetails;
  }

  pausedVariables(): VariableStore | null {
    return this._pausedVariables;
  }

  sourceContainer() {
    return this._sourceContainer;
  }

  executionContexts(): Cdp.Runtime.ExecutionContextDescription[] {
    return Array.from(this._executionContexts.values());
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

  async initialize(): Promise<boolean> {
    this._cdp.Runtime.on('executionContextCreated', event => {
      this._executionContextCreated(event.context);
    });
    this._cdp.Runtime.on('executionContextDestroyed', event => {
      this._executionContextDestroyed(event.executionContextId);
    });
    this._cdp.Runtime.on('executionContextsCleared', () => {
      this.replVariables.clear();
      this._executionContextsCleared();
    });
    this._cdp.Runtime.on('consoleAPICalled', event => {
      if (this._state === 'normal')
        this._onConsoleMessage(event);
    });
    this._cdp.Runtime.on('exceptionThrown', event => {
      if (this._state === 'normal')
        this._onExceptionThrown(event.exceptionDetails);
    });
    if (!await this._cdp.Runtime.enable({}))
      return false;

    this._cdp.Debugger.on('paused', event => {
      this._pausedDetails = this._createPausedDetails(event);
      this._pausedVariables = new VariableStore(this._cdp);
      if (this._state === 'normal')
        this._reportPaused();
    });
    this._cdp.Debugger.on('resumed', () => this._onResumed);
    this._cdp.Debugger.on('scriptParsed', event => this._onScriptParsed(event));
    if (!await this._cdp.Debugger.enable({}))
      return false;
    if (!await this._cdp.Debugger.setAsyncCallStackDepth({maxDepth: 32}))
      return false;
    if (!await this.updatePauseOnExceptionsState())
      return false;

    const customBreakpointPromises: Promise<boolean>[] = [];
    for (const id of this.target.manager.customBreakpoints())
      customBreakpointPromises.push(this.updateCustomBreakpoint(id, true));
    // Do not fail for custom breakpoints not set, to account for
    // future changes in cdp vs stale breakpoints saved in the workspace.
    await Promise.all(customBreakpointPromises);

    if (this._state === 'disposed')
      return true;

    this._state = 'normal';
    console.assert(!this.target.manager.threads.has(this._threadId));
    this.target.manager.threads.set(this._threadId, this);
    this._dap.thread({reason: 'started', threadId: this._threadId});
    if (this._pausedDetails)
      this._reportPaused();
    return true;
  }

  _executionContextCreated(context: Cdp.Runtime.ExecutionContextDescription) {
    this._executionContexts.set(context.id, context);
    this.target.manager.reportExecutionContexts();
  }

  _executionContextDestroyed(contextId: number) {
    this._executionContexts.delete(contextId);
    this.target.manager.reportExecutionContexts();
  }

  _executionContextsCleared() {
    this._removeAllScripts();
    if (this._pausedDetails)
      this._onResumed();
    this._executionContexts.clear();
    this.target.manager.reportExecutionContexts();
  }

  _onResumed() {
    this._pausedDetails = null;
    this._pausedVariables = null;
    if (this._state === 'normal')
      this._dap.continued({threadId: this._threadId});
  }

  async dispose() {
    this._executionContextsCleared();
    this._removeAllScripts();
    if (this._state === 'normal') {
      console.assert(this.target.manager.threads.get(this._threadId) === this);
      this.target.manager.threads.delete(this._threadId);
      this._dap.thread({reason: 'exited', threadId: this._threadId});
    }
    this._state = 'disposed';
    debugThread(`Thread destroyed #${this._threadId}: ${this._threadName}`);
  }

  setThreadDetails(threadName: string, threadNameWithIndentation: string, threadUrl: string) {
    this._threadName = threadName;
    this._threadNameWithIndentation = threadNameWithIndentation;
    this._threadUrl = threadUrl;
    debugThread(`Thread renamed #${this._threadId}: ${this._threadName}`);
  }

  locationFromDebuggerCallFrame(callFrame: Cdp.Debugger.CallFrame): Location {
    return {
      url: callFrame.url,
      lineNumber: callFrame.location.lineNumber,
      columnNumber: callFrame.location.columnNumber || 0,
      source: this._scripts.get(callFrame.location.scriptId)
    };
  }

  locationFromRuntimeCallFrame(callFrame: Cdp.Runtime.CallFrame): Location {
    return {
      url: callFrame.url,
      lineNumber: callFrame.lineNumber,
      columnNumber: callFrame.columnNumber,
      source: this._scripts.get(callFrame.scriptId)
    };
  }

  locationFromDebugger(location: Cdp.Debugger.Location): Location {
    const script = this._scripts.get(location.scriptId);
    return {
      url: script ? script.url() : '',
      lineNumber: location.lineNumber,
      columnNumber: location.columnNumber || 0,
      source: script
    };
  }

  async updatePauseOnExceptionsState(): Promise<boolean> {
    return !!await this._cdp.Debugger.setPauseOnExceptions({state: this.target.manager.pauseOnExceptionsState()});
  }

  async updateCustomBreakpoint(id: string, enabled: boolean): Promise<boolean> {
    if (!this._supportsCustomBreakpoints)
      return true;
    const breakpoint = customBreakpoints().get(id);
    if (!breakpoint)
      return false;
    return breakpoint.apply(this._cdp, enabled);
  }

  _reportPaused() {
    const details = this._pausedDetails!;
    this._dap.stopped({
      reason: details.reason,
      description: details.description,
      threadId: this._threadId,
      text: details.text,
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
    let stackTrace: StackTrace | undefined;
    let uiLocation: Location | undefined;
    if (event.stackTrace) {
      stackTrace = StackTrace.fromRuntime(this, event.stackTrace);
      const frames = await stackTrace.loadFrames(1);
      if (frames.length)
        uiLocation = this._sourceContainer.uiLocation(frames[0].location);
      if (event.type !== 'error' && event.type !== 'warning')
        stackTrace = undefined;
    }

    let category: 'console' | 'stdout' | 'stderr' | 'telemetry' = 'stdout';
    if (event.type === 'error')
      category = 'stderr';
    if (event.type === 'warning')
      category = 'console';

    const tokens: string[] = [];
    for (const arg of event.args)
      tokens.push(objectPreview.renderValue(arg, false));
    const messageText = tokens.join(' ');

    const allPrimitive = !event.args.find(a => !!a.objectId);
    if (allPrimitive && !stackTrace) {
      this._dap.output({
        category,
        output: messageText,
        variablesReference: 0,
        line: uiLocation ? uiLocation.lineNumber : undefined,
        column: uiLocation ? uiLocation.columnNumber : undefined,
      });
      return;
    }

    const variablesReference = await this.replVariables.createVariableForMessageFormat(messageText, event.args, stackTrace);
    this._dap.output({
      category,
      output: '',
      variablesReference,
      line: uiLocation ? uiLocation.lineNumber : undefined,
      column: uiLocation ? uiLocation.columnNumber : undefined,
    });
  }

  async _onExceptionThrown(details: Cdp.Runtime.ExceptionDetails): Promise<void> {
    let stackTrace: StackTrace | undefined;
    let uiLocation: Location | undefined;
    if (details.stackTrace)
      stackTrace = StackTrace.fromRuntime(this, details.stackTrace);
    const frames: StackFrame[] = stackTrace ? await stackTrace.loadFrames(50) : [];
    if (frames.length)
      uiLocation = this._sourceContainer.uiLocation(frames[0].location);
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
    this._sourceContainer.removeSources(...scripts);
  }

  _onScriptParsed(event: Cdp.Debugger.ScriptParsedEvent) {
    const readableUrl = event.url || `VM${event.scriptId}`;
    const source = this._sourceContainer.createSource(readableUrl, async () => {
      const response = await this._cdp.Debugger.getScriptSource({scriptId: event.scriptId});
      return response ? response.scriptSource : undefined;
    });
    if (event.startLine || event.startColumn) {
      source.setInlineSourceRange({
        startLine: event.startLine,
        startColumn: event.startColumn,
        endLine: event.endLine,
        endColumn: event.endColumn
      });
    }
    this._scripts.set(event.scriptId, source);
    this._sourceContainer.addSource(source);
    if (event.sourceMapURL) {
      // TODO(dgozman): reload source map when target url changes.
      const resolvedSourceUrl = utils.completeUrl(this._threadUrl, event.url);
      const resolvedSourceMapUrl = resolvedSourceUrl && utils.completeUrl(resolvedSourceUrl, event.sourceMapURL);
      if (resolvedSourceMapUrl)
        this._sourceContainer.attachSourceMap(source, resolvedSourceMapUrl);
    }
  }
};
