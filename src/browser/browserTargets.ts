// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import Cdp from '../cdp/api';
import CdpConnection from '../cdp/connection';
import * as debug from 'debug';
import * as path from 'path';
import * as vscode from 'vscode';
import { URL } from 'url';
import { Thread, ThreadManager, ThreadDelegate, ExecutionContext } from '../adapter/threads';
import { FrameModel, Frame } from './frames';
import { ServiceWorkerModel } from './serviceWorkers';
import { SourcePathResolver, InlineScriptOffset } from '../adapter/sources';
import { Target } from '../adapter/targets';

const debugTarget = debug('target');

export type PauseOnExceptionsState = 'none' | 'uncaught' | 'all';

export class BrowserTargetManager implements vscode.Disposable {
  private _connection: CdpConnection;
  private _targets: Map<Cdp.Target.TargetID, BrowserTarget> = new Map();
  private _browser: Cdp.Api;
  readonly frameModel = new FrameModel();
  readonly serviceWorkerModel = new ServiceWorkerModel(this.frameModel);
  _threadManager: ThreadManager;
  _sourcePathResolver: SourcePathResolver;

  private _onTargetAddedEmitter = new vscode.EventEmitter<BrowserTarget>();
  private _onTargetRemovedEmitter = new vscode.EventEmitter<BrowserTarget>();
  readonly onTargetAdded = this._onTargetAddedEmitter.event;
  readonly onTargetRemoved = this._onTargetRemovedEmitter.event;

  constructor(threadManager: ThreadManager, connection: CdpConnection, sourcePathResolver: SourcePathResolver) {
    this._connection = connection;
    this._threadManager = threadManager;
    this._sourcePathResolver = sourcePathResolver;
    this._browser = connection.browser();
    this._browser.Target.on('targetInfoChanged', event => {
      this._targetInfoChanged(event.targetInfo);
    });
    this.serviceWorkerModel.onDidChange(() => this._serviceWorkersStatusChanged());
  }

  dispose() {
    this.serviceWorkerModel.dispose();
  }

  targets(): BrowserTarget[] {
    return Array.from(this._targets.values());
  }

  targetForest(): Target[] {
    const reported: Set<string> = new Set();
    const toTarget = (target: BrowserTarget, context: ExecutionContext, isThread: boolean, type: string, name?: string): Target => {
      const uniqueContextId = target._targetInfo.targetId + ':' + context.description.id;
      reported.add(uniqueContextId);
      return {
        id: uniqueContextId,
        type,
        name: name || context.description.name || context.thread.name(),
        fileName: this._sourcePathResolver.urlToAbsolutePath(target._targetInfo.url),
        thread: isThread ? context.thread : undefined,
        executionContext: context,
        children: [],
        stop: target.canStop() ? () => target.stop() : undefined,
        restart: target.canRestart() ? () => target.restart() : undefined
      };
    };

    // Go over the contexts, bind them to frames.
    const mainForFrameId: Map<Cdp.Page.FrameId, Target> = new Map();
    const mainForTarget: Map<BrowserTarget, Target> = new Map();
    const worldsForFrameId: Map<Cdp.Page.FrameId, Target[]> = new Map();
    for (const target of this.targets()) {
      const thread = target.thread();
      if (!thread)
        continue;
      for (const context of thread.executionContexts()) {
        const description = context.description;
        const frameId = description.auxData ? description.auxData['frameId'] : undefined;
        const isDefault = description.auxData ? description.auxData['isDefault'] : false;
        const frame = frameId ? this.frameModel.frameForId(frameId) : undefined;
        if (frame && isDefault) {
          const name = frame.parentFrame() ? frame.displayName() : thread.name();
          const isThread = !!this._targets.get(frame.id);
          const dapContext = toTarget(target, context, isThread, frame.isMainFrame() ? 'page' : 'iframe', name);
          mainForFrameId.set(frameId, dapContext);
          if (isThread)
            mainForTarget.set(target, dapContext);
        } else if (frameId) {
          let contexts = worldsForFrameId.get(frameId);
          if (!contexts) {
            contexts = [];
            worldsForFrameId.set(frameId, contexts);
          }
          contexts.push(toTarget(target, context, false, 'content_script'));
        }
      }
    }

    // Visit frames and use bindings above to build context tree.
    const visitFrames = (frame: Frame, container: Target[]) => {
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

    const result: Target[] = [];
    const mainFrame = this.frameModel.mainFrame();
    if (mainFrame)
      visitFrames(mainFrame, result);

    // Traverse remaining contexts, use target hierarchy. Unlink service workers to be top level.
    for (const target of this.targets()) {
      const thread = target.thread();
      if (!thread)
        continue;

      let reportType = target._targetInfo.type;
      let container = result;
      if (target.isServiceWorkerWorker())
        reportType = 'service_worker';

      if (reportType !== 'service_worker') {
        // Which target should own the context?
        for (let t: BrowserTarget | undefined = target; t; t = t.parentTarget) {
          const parentContext = mainForTarget.get(t);
          if (parentContext) {
            container = parentContext.children;
            break;
          }
        }
      }

      // Put all contexts there, mark all as threads since they are independent.
      for (const context of thread.executionContexts()) {
        if (reported.has(target._targetInfo.targetId + ':' + context.description.id))
          continue;
        container.push(toTarget(target, context, true, reportType));
      }
    }
    return result;
  }

  waitForMainTarget(): Promise<BrowserTarget | undefined> {
    let callback: (result: BrowserTarget | undefined) => void;
    const promise = new Promise<BrowserTarget | undefined>(f => callback = f);
    this._browser.Target.setDiscoverTargets({ discover: true });
    this._browser.Target.on('targetCreated', async event => {
      if (this._targets.size)
        return;
      const targetInfo = event.targetInfo;
      if (targetInfo.type !== 'page')
        return;
      const response = await this._browser.Target.attachToTarget({ targetId: targetInfo.targetId, flatten: true });
      if (!response) {
        callback(undefined);
        return;
      }
      callback(this._attachedToTarget(targetInfo, response.sessionId, false));
    });
    this._browser.Target.on('detachedFromTarget', event => {
      this._detachedFromTarget(event.targetId!);
    });
    return promise;
  }

  _attachedToTarget(targetInfo: Cdp.Target.TargetInfo, sessionId: Cdp.Target.SessionID, waitingForDebugger: boolean, parentTarget?: BrowserTarget): BrowserTarget {
    debugTarget(`Attaching to target ${targetInfo.targetId}`);

    const cdp = this._connection.createSession(sessionId);
    const target = new BrowserTarget(this, targetInfo, cdp, parentTarget, target => {
      this._connection.disposeSession(sessionId);
    });
    this._targets.set(targetInfo.targetId, target);
    if (parentTarget)
      parentTarget._children.set(targetInfo.targetId, target);

    cdp.Target.on('attachedToTarget', async event => {
      this._attachedToTarget(event.targetInfo, event.sessionId, event.waitingForDebugger, target);
    });
    cdp.Target.on('detachedFromTarget', async event => {
      this._detachedFromTarget(event.targetId!);
    });
    cdp.Target.setAutoAttach({ autoAttach: true, waitForDebuggerOnStart: true, flatten: true });

    if (target._thread)
      target._thread.initialize();

    if (domDebuggerTypes.has(targetInfo.type))
      this.frameModel.attached(cdp);
    this.serviceWorkerModel.attached(cdp);

    if (waitingForDebugger)
      cdp.Runtime.runIfWaitingForDebugger({});
    this._onTargetAddedEmitter.fire(target);
    debugTarget(`Attached to target ${targetInfo.targetId}`);
    return target;
  }

  _detachedFromTarget(targetId: string) {
    const target = this._targets.get(targetId);
    if (!target)
      return;
    debugTarget(`Detaching from target ${targetId}`);

    for (const childTargetId of target._children.keys())
      this._detachedFromTarget(childTargetId);
    target._detached();

    this._targets.delete(targetId);
    if (target.parentTarget)
      target.parentTarget._children.delete(targetId);

    this._onTargetRemovedEmitter.fire(target);
    debugTarget(`Detached from target ${targetId}`);
    if (!this._targets.size)
      this._connection.browser().Browser.close({});
  }

  _targetInfoChanged(targetInfo: Cdp.Target.TargetInfo) {
    const target = this._targets.get(targetInfo.targetId);
    if (!target)
      return;
    target._updateFromInfo(targetInfo);
  }

  _serviceWorkersStatusChanged() {
    for (const target of this._targets.values())
      target._updateThreadName();
  }
}

const jsTypes = new Set(['page', 'iframe', 'worker']);
const domDebuggerTypes = new Set(['page', 'iframe']);

export class BrowserTarget implements ThreadDelegate {
  readonly targetId: Cdp.Target.TargetID;
  readonly parentTarget?: BrowserTarget;

  private _manager: BrowserTargetManager;
  private _cdp: Cdp.Api;
  _thread: Thread | undefined;
  _targetInfo: Cdp.Target.TargetInfo;
  private _ondispose: (t: BrowserTarget) => void;

  _children: Map<Cdp.Target.TargetID, BrowserTarget> = new Map();

  constructor(targetManager: BrowserTargetManager, targetInfo: Cdp.Target.TargetInfo, cdp: Cdp.Api, parentTarget: BrowserTarget | undefined, ondispose: (t: BrowserTarget) => void) {
    this._cdp = cdp;
    this._manager = targetManager;
    this.targetId = targetInfo.targetId;
    this.parentTarget = parentTarget;
    if (jsTypes.has(targetInfo.type))
      this._thread = targetManager._threadManager.createThread(targetInfo.targetId, cdp, this);
    this._updateFromInfo(targetInfo);
    this._ondispose = ondispose;
  }

  cdp(): Cdp.Api {
    return this._cdp;
  }

  thread(): Thread | undefined {
    return this._thread;
  }

  copyToClipboard(text: string) {
    return vscode.env.clipboard.writeText(text);
  }

  canStop(): boolean {
    return this.isServiceWorkerWorker();
  }

  stop() {
    // Stop both dedicated and parent service worker scopes for present and future browsers.
    this._manager.serviceWorkerModel.stopWorker(this.targetId);
    if (!this.parentTarget)
      return;
    this._manager.serviceWorkerModel.stopWorker(this.parentTarget.targetId);
  }

  canRestart(): boolean {
    return !this.parentTarget;
  }

  restart() {
    this.cdp().Page.reload({});
  }

  supportsCustomBreakpoints(): boolean {
    return domDebuggerTypes.has(this._targetInfo.type);
  }

  sourcePathResolver(): SourcePathResolver {
    return this._manager._sourcePathResolver;
  }

  defaultScriptOffset(): InlineScriptOffset | undefined {
    return undefined;
  }

  isServiceWorkerWorker(): boolean {
    return this._targetInfo.type === 'worker' && !!this.parentTarget && this.parentTarget._targetInfo.type === 'service_worker';
  }

  _updateFromInfo(targetInfo: Cdp.Target.TargetInfo) {
    this._targetInfo = targetInfo;
    this._updateThreadName();
    if (this._thread)
      this._thread.setBaseUrl(this._targetInfo.url);
  }

  _updateThreadName() {
    if (!this._thread)
      return;

    if (this.isServiceWorkerWorker()) {
      const version = this._manager.serviceWorkerModel.version(this.parentTarget!.targetId);
      if (version) {
        this._thread.setName(version.label());
        return;
      }
    }

    let threadName = '';
    try {
      const parsedURL = new URL(this._targetInfo.url);
      if (parsedURL.pathname === '/')
        threadName += parsedURL.host;
      else if (parsedURL.protocol === 'data:')
        threadName = '<data>';
      else
        threadName += parsedURL ? path.basename(parsedURL.pathname) + (parsedURL.hash ? parsedURL.hash : '') : this._targetInfo.title;
    } catch (e) {
      threadName += this._targetInfo.url;
    }

    this._thread.setName(threadName);
  }

  _detached() {
    if (this._thread)
      this._thread.dispose();
    this._manager.serviceWorkerModel.detached(this._cdp);
    this._ondispose(this);
  }

  _visit(visitor: (t: BrowserTarget) => void) {
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
