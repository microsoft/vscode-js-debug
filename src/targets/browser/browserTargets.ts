/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as path from 'path';
import { URL } from 'url';
import { IDisposable, EventEmitter } from '../../common/events';
import { ITarget } from '../../targets/targets';
import Cdp from '../../cdp/api';
import CdpConnection from '../../cdp/connection';
import * as urlUtils from '../../common/urlUtils';
import { FrameModel } from './frames';
import { ServiceWorkerModel } from './serviceWorkers';
import { ISourcePathResolver } from '../../common/sourcePathResolver';
import { ScriptSkipper } from '../../adapter/scriptSkipper';
import { AnyChromeConfiguration } from '../../configuration';
import { LogTag, ILogger } from '../../common/logging';
import { TelemetryReporter } from '../../telemetry/telemetryReporter';
import { killTree } from '../node/killTree';
import { IThreadDelegate } from '../../adapter/threads';
import { ITargetOrigin } from '../targetOrigin';
import { IBrowserProcess } from './browserProcess';
import { IBrowserVersionMetrics } from '../../telemetry/classification';
import * as nls from 'vscode-nls';

const localize = nls.loadMessageBundle();

export type PauseOnExceptionsState = 'none' | 'uncaught' | 'all';

export class BrowserTargetManager implements IDisposable {
  private _connection: CdpConnection;
  private _targets: Map<Cdp.Target.TargetID, BrowserTarget> = new Map();
  private _browser: Cdp.Api;
  readonly frameModel = new FrameModel();
  readonly serviceWorkerModel = new ServiceWorkerModel(this.frameModel);
  _sourcePathResolver: ISourcePathResolver;
  _targetOrigin: ITargetOrigin;
  _scriptSkipper?: ScriptSkipper;

  private _onTargetAddedEmitter = new EventEmitter<BrowserTarget>();
  private _onTargetRemovedEmitter = new EventEmitter<BrowserTarget>();
  readonly onTargetAdded = this._onTargetAddedEmitter.event;
  readonly onTargetRemoved = this._onTargetRemovedEmitter.event;

  static async connect(
    connection: CdpConnection,
    process: undefined | IBrowserProcess,
    sourcePathResolver: ISourcePathResolver,
    launchParams: AnyChromeConfiguration,
    logger: ILogger,
    telemetry: TelemetryReporter,
    targetOrigin: ITargetOrigin,
  ): Promise<BrowserTargetManager | undefined> {
    const rootSession = connection.rootSession();
    const result = await rootSession.Target.attachToBrowserTarget({});
    if (!result) return;
    const browserSession = connection.createSession(result.sessionId);
    return new BrowserTargetManager(
      connection,
      process,
      browserSession,
      sourcePathResolver,
      logger,
      telemetry,
      launchParams,
      targetOrigin,
    );
  }

  constructor(
    connection: CdpConnection,
    private readonly process: IBrowserProcess | undefined,
    browserSession: Cdp.Api,
    sourcePathResolver: ISourcePathResolver,
    private readonly logger: ILogger,
    private readonly telemetry: TelemetryReporter,
    private readonly launchParams: AnyChromeConfiguration,
    targetOrigin: ITargetOrigin,
  ) {
    this._connection = connection;
    this._sourcePathResolver = sourcePathResolver;
    this._browser = browserSession;
    this._browser.Target.on('targetInfoChanged', event => {
      this._targetInfoChanged(event.targetInfo);
    });
    this._targetOrigin = targetOrigin;
    this.serviceWorkerModel.onDidChange(() => {
      for (const target of this._targets.values()) {
        if (target.isServiceWorker()) target._onNameChangedEmitter.fire();
      }
    });
  }

  dispose() {
    this.serviceWorkerModel.dispose();
  }

  targetList(): ITarget[] {
    return Array.from(this._targets.values()).filter(target =>
      jsTypes.has(target._targetInfo.type),
    );
  }

  async closeBrowser(): Promise<void> {
    await this._browser.Browser.close({});

    if (this.process && this.process.pid) {
      killTree(this.process.pid, this.logger);
    }
  }

  waitForMainTarget(
    filter?: (target: Cdp.Target.TargetInfo) => boolean,
  ): Promise<BrowserTarget | undefined> {
    let callback: (result: BrowserTarget | undefined) => void;
    let attachmentQueue = Promise.resolve();
    const promise = new Promise<BrowserTarget | undefined>(f => (callback = f));
    const attachInner = async ({ targetInfo }: { targetInfo: Cdp.Target.TargetInfo }) => {
      if (this._targets.size) {
        return;
      }
      if (targetInfo.type !== 'page') {
        return;
      }
      if (filter && !filter(targetInfo)) {
        return;
      }

      // Watch for info updates in case things come through while we're
      // still attaching. See: https://github.com/microsoft/vscode/issues/90149
      const updateListener = this._browser.Target.on('targetInfoChanged', evt => {
        if (evt.targetInfo.targetId === targetInfo.targetId) {
          targetInfo = evt.targetInfo;
        }
      });

      let response: Cdp.Target.AttachToBrowserTargetResult | undefined;
      try {
        response = await this._browser.Target.attachToTarget({
          targetId: targetInfo.targetId,
          flatten: true,
        });
      } finally {
        updateListener.dispose();
      }

      if (!response) {
        callback(undefined);
        return;
      }

      callback(this._attachedToTarget(targetInfo, response.sessionId, true));
    };

    const attemptAttach = (info: { targetInfo: Cdp.Target.TargetInfo }) => {
      attachmentQueue = attachmentQueue.then(() => attachInner(info));
    };

    this._browser.Target.setDiscoverTargets({ discover: true });
    this._browser.Target.on('targetCreated', attemptAttach); // new page
    this._browser.Target.on('targetInfoChanged', attemptAttach); // nav on existing page
    this._browser.Target.on('detachedFromTarget', event => {
      if (event.targetId) {
        this._detachedFromTarget(event.targetId);
      }
    });

    return promise;
  }

  _attachedToTarget(
    targetInfo: Cdp.Target.TargetInfo,
    sessionId: Cdp.Target.SessionID,
    waitingForDebugger: boolean,
    parentTarget?: BrowserTarget,
  ): BrowserTarget {
    const cdp = this._connection.createSession(sessionId);
    const target = new BrowserTarget(this, targetInfo, cdp, parentTarget, waitingForDebugger, () =>
      this._connection.disposeSession(sessionId),
    );
    this._targets.set(targetInfo.targetId, target);
    if (parentTarget) parentTarget._children.set(targetInfo.targetId, target);

    cdp.Target.on('attachedToTarget', async event => {
      this._attachedToTarget(event.targetInfo, event.sessionId, event.waitingForDebugger, target);
    });
    cdp.Target.on('detachedFromTarget', async event => {
      if (event.targetId) {
        this._detachedFromTarget(event.targetId);
      }
    });
    cdp.Target.setAutoAttach({ autoAttach: true, waitForDebuggerOnStart: true, flatten: true });

    cdp.Network.setCacheDisabled({
      cacheDisabled: this.launchParams.disableNetworkCache,
    }).catch(err =>
      this.logger.info(LogTag.RuntimeTarget, 'Error setting network cache state', err),
    );

    // For the 'top-level' page, gather telemetry.
    if (!parentTarget) {
      this.retrieveBrowserTelemetry(cdp);
    }

    if (domDebuggerTypes.has(targetInfo.type)) this.frameModel.attached(cdp, targetInfo.targetId);
    this.serviceWorkerModel.attached(cdp);

    this._onTargetAddedEmitter.fire(target);

    // For targets that we don't report to the system, auto-resume them on our on.
    if (!jsTypes.has(targetInfo.type)) cdp.Runtime.runIfWaitingForDebugger({});

    return target;
  }

  private async retrieveBrowserTelemetry(cdp: Cdp.Api) {
    try {
      const info = await cdp.Browser.getVersion({});
      if (!info) {
        throw new Error('Undefined return from getVersion()');
      }

      const properties: IBrowserVersionMetrics = {
        targetCRDPVersion: info.protocolVersion,
        targetRevision: info.revision,
        targetUserAgent: info.userAgent,
        targetV8: info.jsVersion,
        targetVersion: '',
        targetProject: '',
        targetProduct: '',
      };

      this.logger.verbose(LogTag.RuntimeTarget, 'Retrieved browser information', info);

      const parts = (info.product || '').split('/');
      if (parts.length === 2) {
        // Currently response.product looks like "Chrome/65.0.3325.162" so we split the project and the actual version number
        properties.targetProject = parts[0];
        properties.targetVersion = parts[1];
      } else {
        // If for any reason that changes, we submit the entire product as-is
        properties.targetProduct = info.product;
      }

      this.telemetry.report('browserVersion', properties);
    } catch (e) {
      this.logger.warn(LogTag.RuntimeTarget, 'Error getting browser telemetry', e);
    }
  }

  async _detachedFromTarget(targetId: string) {
    const target = this._targets.get(targetId);
    if (!target) return;

    await Promise.all([...target._children.keys()].map(k => this._detachedFromTarget(k)));

    try {
      await target._detached();
    } catch {
      // ignored -- any network error when we want to detach anyway is fine
    }

    this._targets.delete(targetId);
    if (target.parentTarget) target.parentTarget._children.delete(targetId);

    this._onTargetRemovedEmitter.fire(target);

    if (!this._targets.size) {
      try {
        await this._browser.Browser.close({});
      } catch {
        // ignored -- any network error when we want to detach anyway is fine
      }
    }
  }

  _targetInfoChanged(targetInfo: Cdp.Target.TargetInfo) {
    const target = this._targets.get(targetInfo.targetId);
    if (!target) return;
    target._updateFromInfo(targetInfo);
  }
}

const jsTypes = new Set(['page', 'iframe', 'worker', 'service_worker']);
const domDebuggerTypes = new Set(['page', 'iframe']);

export class BrowserTarget implements ITarget, IThreadDelegate {
  readonly parentTarget: BrowserTarget | undefined;
  private _manager: BrowserTargetManager;
  private _cdp: Cdp.Api;
  _targetInfo: Cdp.Target.TargetInfo;
  private _ondispose: (t: BrowserTarget) => void;
  private _waitingForDebugger: boolean;
  private _attached = false;
  _onNameChangedEmitter = new EventEmitter<void>();
  readonly onNameChanged = this._onNameChangedEmitter.event;

  _children: Map<Cdp.Target.TargetID, BrowserTarget> = new Map();

  constructor(
    targetManager: BrowserTargetManager,
    targetInfo: Cdp.Target.TargetInfo,
    cdp: Cdp.Api,
    parentTarget: BrowserTarget | undefined,
    waitingForDebugger: boolean,
    ondispose: (t: BrowserTarget) => void,
  ) {
    this._cdp = cdp;
    cdp.pause();

    this._manager = targetManager;
    this.parentTarget = parentTarget;
    this._waitingForDebugger = waitingForDebugger;
    this._targetInfo = targetInfo;
    this._updateFromInfo(targetInfo);
    this._ondispose = ondispose;
  }

  targetOrigin() {
    return this._manager._targetOrigin;
  }

  id(): string {
    return this._targetInfo.targetId;
  }

  cdp(): Cdp.Api {
    return this._cdp;
  }

  name(): string {
    return this._computeName();
  }

  fileName(): string | undefined {
    return this._targetInfo.url;
  }

  type(): string {
    return this._targetInfo.type;
  }

  afterBind() {
    this._cdp.resume();
    return Promise.resolve();
  }

  initialize() {
    return Promise.resolve();
  }

  parent(): ITarget | undefined {
    if (this.parentTarget && !jsTypes.has(this.parentTarget.type()))
      return this.parentTarget.parentTarget;
    return this.parentTarget;
  }

  children(): ITarget[] {
    const result: ITarget[] = [];
    for (const target of this._children.values()) {
      if (jsTypes.has(target.type())) result.push(target);
      else result.push(...target.children());
    }
    return result;
  }

  canStop(): boolean {
    return this.isServiceWorker();
  }

  stop() {
    // Stop both dedicated and parent service worker scopes for present and future browsers.
    this._manager.serviceWorkerModel.stopWorker(this.id());
    if (!this.parentTarget) return;
    this._manager.serviceWorkerModel.stopWorker(this.parentTarget.id());
  }

  canRestart() {
    return this._targetInfo.type === 'page';
  }

  restart() {
    this._cdp.Page.reload({});
  }

  waitingForDebugger(): boolean {
    return this._waitingForDebugger;
  }

  canAttach(): boolean {
    return !this._attached;
  }

  async attach(): Promise<Cdp.Api> {
    this._waitingForDebugger = false;
    this._attached = true;
    return Promise.resolve(this._cdp);
  }

  canDetach(): boolean {
    return this._attached;
  }

  async detach(): Promise<void> {
    this._attached = false;
  }

  executionContextName(description: Cdp.Runtime.ExecutionContextDescription): string {
    const auxData = description.auxData;
    const contextName = description.name;
    if (!auxData) return contextName;
    const frameId = auxData['frameId'];
    const frame = frameId ? this._manager.frameModel.frameForId(frameId) : undefined;
    if (frame && auxData['isDefault'] && !frame.parentFrame()) return 'top';
    if (frame && auxData['isDefault']) return frame.displayName();
    if (frame) return `${contextName}`;
    return contextName;
  }

  supportsCustomBreakpoints(): boolean {
    return domDebuggerTypes.has(this._targetInfo.type);
  }

  shouldCheckContentHash(): boolean {
    // Browser executes scripts retrieved from network.
    // We check content hash because served code can be different from actual files on disk.
    return true;
  }

  scriptUrlToUrl(url: string): string {
    return urlUtils.completeUrl(this._targetInfo.url, url) || url;
  }

  sourcePathResolver(): ISourcePathResolver {
    return this._manager._sourcePathResolver;
  }

  isServiceWorker(): boolean {
    return this._targetInfo.type === 'service_worker';
  }

  _updateFromInfo(targetInfo: Cdp.Target.TargetInfo) {
    this._targetInfo = targetInfo;
    this._onNameChangedEmitter.fire();
  }

  _computeName(): string {
    if (this.isServiceWorker()) {
      const version = this._manager.serviceWorkerModel.version(this.id());
      if (version) return version.label() + ' [Service Worker]';
    }

    let threadName = '';
    try {
      const parsedURL = new URL(this._targetInfo.url);
      if (parsedURL.pathname === '/') threadName += parsedURL.host;
      else if (parsedURL.protocol === 'data:') threadName = '<data>';
      else
        threadName += parsedURL
          ? path.basename(parsedURL.pathname) + (parsedURL.hash ? parsedURL.hash : '')
          : this._targetInfo.title;
    } catch (e) {
      threadName += this._targetInfo.url || localize('chrome.pagePlaceholder', 'Target Page');
    }
    return threadName;
  }

  async _detached() {
    await this._manager.serviceWorkerModel.detached(this._cdp);
    this._ondispose(this);
  }
}
