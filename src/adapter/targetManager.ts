/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import Cdp from '../cdp/api';
import CdpConnection from '../cdp/connection';
import * as debug from 'debug';
import * as path from 'path';
import * as vscode from 'vscode';
import { URL } from 'url';
import { Thread } from './thread';
import { SourceContainer } from './source';
import Dap from '../dap/api';
import { FrameModel, Frame } from '../cdp/frameModel';
import { ThreadManager } from './threadManager';

const debugTarget = debug('target');

export type PauseOnExceptionsState = 'none' | 'uncaught' | 'all';

export interface ExecutionContext {
  contextId?: number;
  name: string;
  threadId: number;
  children: ExecutionContext[];
}

export class TargetManager {
  private _connection: CdpConnection;
  private _targets: Map<Cdp.Target.TargetID, Target> = new Map();
  private _mainTarget?: Target;
  private _browser: Cdp.Api;
  private _dap: Dap.Api;
  readonly frameModel = new FrameModel();
  readonly threadManager: ThreadManager;

  private _onTargetAddedEmitter = new vscode.EventEmitter<Target>();
  private _onTargetRemovedEmitter = new vscode.EventEmitter<Target>();
  private _onExecutionContextsChangedEmitter: vscode.EventEmitter<ExecutionContext[]> = new vscode.EventEmitter<ExecutionContext[]>();
  readonly onTargetAdded = this._onTargetAddedEmitter.event;
  readonly onTargetRemoved = this._onTargetRemovedEmitter.event;
  readonly onExecutionContextsChanged = this._onExecutionContextsChangedEmitter.event;

  constructor(connection: CdpConnection, dap: Dap.Api, sourceContainer: SourceContainer) {
    this._connection = connection;
    this._dap = dap;
    this.threadManager = new ThreadManager(sourceContainer);
    this.threadManager.onExecutionContextsChanged(() => this._reportExecutionContexts());
    this._browser = connection.browser();
    this._attachToFirstPage();
    this._browser.Target.on('targetInfoChanged', event => {
      this._targetInfoChanged(event.targetInfo);
    });
  }

  mainTarget(): Target | undefined {
    return this._mainTarget;
  }

  targets(): Target[] {
    return Array.from(this._targets.values());
  }

  _reportExecutionContexts() {
    const reported: Set<string> = new Set();
    const toDap = (thread: Thread, context: Cdp.Runtime.ExecutionContextDescription, name?: string) => {
      reported.add(thread.threadId() + ':' + context.id);
      return {
        contextId: context.id,
        name: name || context.name || thread.threadName(),
        threadId: thread.threadId(),
        children: []
      };
    };

    // Go over the contexts, bind them to frames.
    const mainForFrameId: Map<Cdp.Page.FrameId, ExecutionContext> = new Map();
    const mainForTarget: Map<Target, ExecutionContext> = new Map();
    const worldsForFrameId: Map<Cdp.Page.FrameId, ExecutionContext[]> = new Map();
    for (const target of this.targets()) {
      const thread = target.thread();
      if (!thread)
        continue;
      for (const context of thread.executionContexts()) {
        const frameId = context.auxData ? context.auxData['frameId'] : null;
        const isDefault = context.auxData ? context.auxData['isDefault'] : false;
        const frame = frameId ? this.frameModel.frameForId(frameId) : null;
        if (frameId && isDefault) {
          const name = frame!.parentFrame ? frame!.displayName() : thread.threadName();
          const dapContext = toDap(thread, context, name);
          mainForFrameId.set(frameId, dapContext);
          if (!frame!.parentFrame)
            mainForTarget.set(target, dapContext);
        } else if (frameId) {
          let contexts = worldsForFrameId.get(frameId);
          if (!contexts) {
            contexts = [];
            worldsForFrameId.set(frameId, contexts);
          }
          contexts.push(toDap(thread, context));
        }
      }
    }

    // Visit frames and use bindings above to build context tree.
    const visitFrames = (frame: Frame, container: ExecutionContext[]) => {
      const main = mainForFrameId.get(frame.id);
      const worlds = worldsForFrameId.get(frame.id) || [];
      if (main) {
        main.children.push(...worlds);
        container.push(main);
        for (const childFrame of frame.childFrames())
          visitFrames(childFrame, main.children);
      } else {
        container.push(...worlds);
        for (const childFrame of frame.childFrames())
          visitFrames(childFrame, container);
      }
    };

    const result: ExecutionContext[] = [];
    const mainFrame = this.frameModel.mainFrame();
    if (mainFrame)
      visitFrames(mainFrame, result);

    // Traverse remaining contexts, use target hierarchy.
    for (const target of this.targets()) {
      let container = result;

      // Which target should own the context?
      for (let t: Target| undefined = target; t; t = t.parentTarget) {
        const parentContext = mainForTarget.get(t);
        if (parentContext) {
          container = parentContext.children;
          break;
        }
      }

      const thread = target.thread();
      if (!thread)
        continue;

      // Put all contexts there.
      for (const context of thread.executionContexts()) {
        if (reported.has(thread.threadId() + ':' + context.id))
          continue;
        container.push(toDap(thread, context));
      }
    }
    this._onExecutionContextsChangedEmitter.fire(result);
  }

  _attachToFirstPage() {
    this._browser.Target.setDiscoverTargets({ discover: true });
    this._browser.Target.on('targetCreated', async event => {
      if (this._targets.size)
        return;
      const targetInfo = event.targetInfo;
      if (targetInfo.type !== 'page')
        return;
      const response = await this._browser.Target.attachToTarget({ targetId: targetInfo.targetId, flatten: true });
      // TODO(dgozman): handle error.
      if (response)
        this._attachedToTarget(targetInfo, response.sessionId, false);
    });
    this._browser.Target.on('detachedFromTarget', event => {
      // TODO(dgozman): targetId is deprecated, we should use sessionId.
      this._detachedFromTarget(event.targetId!);
    });
  }

  async _attachedToTarget(targetInfo: Cdp.Target.TargetInfo, sessionId: Cdp.Target.SessionID, waitingForDebugger: boolean, parentTarget?: Target) {
    debugTarget(`Attaching to target ${targetInfo.targetId}`);

    const cdp = this._connection.createSession(sessionId);
    const target = new Target(this, targetInfo, cdp, this._dap, parentTarget, target => {
      this._connection.disposeSession(sessionId);
    });
    this._targets.set(targetInfo.targetId, target);
    if (parentTarget)
      parentTarget._children.set(targetInfo.targetId, target);

      cdp.Target.on('attachedToTarget', async event => {
      this._attachedToTarget(event.targetInfo, event.sessionId, event.waitingForDebugger, target);
    });
    cdp.Target.on('detachedFromTarget', async event => {
      // TODO(dgozman): targetId is deprecated, we should use sessionId.
      this._detachedFromTarget(event.targetId!);
    });

    const cleanupOnFailure = () => {
      this._targets.delete(targetInfo.targetId);
      this._connection.disposeSession(sessionId);
    }

    if (!await cdp.Target.setAutoAttach({autoAttach: true, waitForDebuggerOnStart: true, flatten: true}))
      return cleanupOnFailure();
    if (!await target._initialize(waitingForDebugger))
      return cleanupOnFailure();

    if (!this._targets.has(targetInfo.targetId))
      return cleanupOnFailure();
    if (!this._mainTarget)
      this._mainTarget = target;
    this._onTargetAddedEmitter.fire(target);
    debugTarget(`Attached to target ${targetInfo.targetId}`);
    this._targetStructureChanged();
  }

  async _detachedFromTarget(targetId: string) {
    const target = this._targets.get(targetId);
    if (!target)
      return;
    debugTarget(`Detaching from target ${targetId}`);

    for (const childTargetId of target._children.keys())
      await this._detachedFromTarget(childTargetId);
    await target._dispose();

    this._targets.delete(targetId);
    if (target.parentTarget)
      target.parentTarget._children.delete(targetId);

    if (this._mainTarget === target)
      this._mainTarget = undefined;
    this._onTargetRemovedEmitter.fire(target);
    debugTarget(`Detached from target ${targetId}`);
    this._targetStructureChanged();
  }

  _targetInfoChanged(targetInfo: Cdp.Target.TargetInfo) {
    const target = this._targets.get(targetInfo.targetId);
    if (!target)
      return;
    target._updateFromInfo(targetInfo);
    this._targetStructureChanged();
  }

  _targetStructureChanged() {
    this._reportExecutionContexts();
  }
}

const jsTypes = new Set(['page', 'iframe', 'worker']);
const domDebuggerTypes = new Set(['page', 'iframe']);

export class Target {
  readonly manager: TargetManager;
  readonly parentTarget?: Target;

  private _cdp: Cdp.Api;
  private _thread: Thread | undefined;
  private _targetInfo: Cdp.Target.TargetInfo;
  private _ondispose: (t:Target) => void;

  _children: Map<Cdp.Target.TargetID, Target> = new Map();

  constructor(targetManager: TargetManager, targetInfo: Cdp.Target.TargetInfo, cdp: Cdp.Api, dap: Dap.Api, parentTarget: Target | undefined, ondispose: (t:Target) => void) {
    this._cdp = cdp;
    this.manager = targetManager;
    this.parentTarget = parentTarget;
    if (jsTypes.has(targetInfo.type))
      this._thread = targetManager.threadManager.createThread(cdp, dap, domDebuggerTypes.has(targetInfo.type));
    this._updateFromInfo(targetInfo);
    this._ondispose = ondispose;
  }

  cdp(): Cdp.Api {
    return this._cdp;
  }

  thread(): Thread | undefined {
    return this._thread;
  }

  targetId(): string {
    return this._targetInfo.targetId;
  }

  async _initialize(waitingForDebugger: boolean): Promise<boolean> {
    if (this._thread && !await this._thread.initialize())
      return false;
    if (domDebuggerTypes.has(this._targetInfo.type) && !await this.manager.frameModel.addTarget(this._cdp))
      return false;
    if (waitingForDebugger && !await this._cdp.Runtime.runIfWaitingForDebugger({}))
      return false;
    return true;
  }

  _updateFromInfo(targetInfo: Cdp.Target.TargetInfo) {
    this._targetInfo = targetInfo;
    if (!this._thread)
      return;

    let indentation = '';
    for (let parent = this.parentTarget; parent; parent = parent.parentTarget) {
      if (parent._targetInfo.type === 'service_worker')
        continue;
      indentation += '\u00A0\u00A0\u00A0\u00A0';
    }

    let icon = '';
    if (targetInfo.type === 'page')
      icon = '\uD83D\uDCC4 ';
    else if (targetInfo.type === 'iframe')
      icon = '\uD83D\uDCC4 ';
    else if (targetInfo.type === 'worker')
      icon = '\uD83D\uDC77 ';

    let threadName = icon;
    try {
      const parsedURL = new URL(targetInfo.url);
      if (parsedURL.pathname === '/')
        threadName += parsedURL.host;
      else
        threadName += parsedURL ? path.basename(parsedURL.pathname) + (parsedURL.hash ? parsedURL.hash : '') : `#${this._thread.threadId()}`;
    } catch (e) {
      threadName += targetInfo.url;
    }

    this._thread.setThreadDetails(threadName, indentation + threadName, targetInfo.url);
  }

  async _dispose() {
    if (this._thread)
      await this._thread.dispose();
    this._ondispose(this);
  }

  _visit(visitor: (t: Target) => void) {
    visitor(this);
    for (const child of this._children.values())
      child._visit(visitor);
  }

  _dumpTarget(indent: string | undefined = '') {
    debugTarget(`${indent}${this._targetInfo.type} - ${this._targetInfo.url}`);
    for (const child of this._children.values())
      child._dumpTarget(indent + '  ');
  }
}
