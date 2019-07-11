// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import Cdp from '../cdp/api';
import * as vscode from 'vscode';
import { Thread } from './thread';
import { SourceContainer } from './source';
import Dap from '../dap/api';

export type PauseOnExceptionsState = 'none' | 'uncaught' | 'all';

export interface ExecutionContext {
  contextId?: number;
  name: string;
  threadId: number;
  children: ExecutionContext[];
}

export class ThreadManager {
  private _pauseOnExceptionsState: PauseOnExceptionsState;
  private _customBreakpoints: Set<string>;
  private _threads: Map<number, Thread> = new Map();

  private _onThreadAddedEmitter = new vscode.EventEmitter<Thread>();
  private _onThreadRemovedEmitter = new vscode.EventEmitter<Thread>();
  private _onExecutionContextsChangedEmitter: vscode.EventEmitter<ExecutionContext[]> = new vscode.EventEmitter<ExecutionContext[]>();
  readonly onThreadAdded = this._onThreadAddedEmitter.event;
  readonly onThreadRemoved = this._onThreadRemovedEmitter.event;
  readonly onExecutionContextsChanged = this._onExecutionContextsChangedEmitter.event;
  readonly sourceContainer: SourceContainer;

  constructor(sourceContainer: SourceContainer) {
    this._pauseOnExceptionsState = 'none';
    this._customBreakpoints = new Set();
    this.sourceContainer = sourceContainer;
  }

  createThread(cdp: Cdp.Api, dap: Dap.Api, supportsCustomBreakpoints: boolean): Thread {
    return new Thread(this, cdp, dap, supportsCustomBreakpoints);
  }

  addThread(threadId: number, thread: Thread) {
    console.assert(!this._threads.has(threadId));
    this._threads.set(threadId, thread);
    this._onThreadAddedEmitter.fire(thread);
  }

  removeThread(threadId: number) {
    const thread = this._threads.get(threadId);
    console.assert(thread);
    this._threads.delete(threadId);
    this._onThreadRemovedEmitter.fire(thread);
  }

  reportExecutionContexts() {
    this._onExecutionContextsChangedEmitter.fire();
  }

  threads(): Thread[] {
    return Array.from(this._threads.values());
  }

  thread(threadId: number): Thread | undefined {
    return this._threads.get(threadId);
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
}