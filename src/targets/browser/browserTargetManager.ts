/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { ScriptSkipper } from '../../adapter/scriptSkipper/implementation';
import Cdp from '../../cdp/api';
import CdpConnection from '../../cdp/connection';
import { EventEmitter, IDisposable } from '../../common/events';
import { ILogger, LogTag } from '../../common/logging';
import { ISourcePathResolver } from '../../common/sourcePathResolver';
import { AnyChromiumConfiguration } from '../../configuration';
import { IBrowserVersionMetrics } from '../../telemetry/classification';
import { ITelemetryReporter } from '../../telemetry/telemetryReporter';
import { ITargetOrigin } from '../targetOrigin';
import { BrowserTarget, BrowserTargetType, domDebuggerTypes, jsTypes } from './browserTargets';
import { FrameModel } from './frames';
import { ServiceWorkerModel } from './serviceWorkers';
import { IBrowserProcess } from './spawn/browserProcess';

export class BrowserTargetManager implements IDisposable {
  private _connection: CdpConnection;
  private _targets: Map<Cdp.Target.SessionID, BrowserTarget> = new Map();
  protected readonly _browser: Cdp.Api;
  private readonly _detachedTargets = new Set();
  readonly frameModel = new FrameModel();
  readonly serviceWorkerModel = new ServiceWorkerModel(this.frameModel);
  private _lifecycleQueue = Promise.resolve();
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
    launchParams: AnyChromiumConfiguration,
    logger: ILogger,
    telemetry: ITelemetryReporter,
    targetOrigin: ITargetOrigin,
  ): Promise<BrowserTargetManager | undefined> {
    const rootSession = connection.rootSession();
    const result = await rootSession.Target.attachToBrowserTarget({});
    if (!result) return;
    const browserSession = connection.createSession(result.sessionId);
    return new this(
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
    private process: IBrowserProcess | undefined,
    browserSession: Cdp.Api,
    sourcePathResolver: ISourcePathResolver,
    private readonly logger: ILogger,
    private readonly telemetry: ITelemetryReporter,
    protected readonly launchParams: AnyChromiumConfiguration,
    targetOrigin: ITargetOrigin,
  ) {
    this._connection = connection;
    this._sourcePathResolver = sourcePathResolver;
    this._browser = browserSession;
    this._targetOrigin = targetOrigin;
    this.serviceWorkerModel.onDidChange(() => {
      for (const target of this._targets.values()) {
        if (target.type() === BrowserTargetType.ServiceWorker) {
          target._onNameChangedEmitter.fire();
        }
      }
    });
  }

  dispose() {
    this.serviceWorkerModel.dispose();
  }

  targetList() {
    return Array.from(this._targets.values()).filter(target => jsTypes.has(target.type()));
  }

  /**
   * Gets information of available page targets matching the filter.
   */

  public async getCandiateInfo(filter?: (target: Cdp.Target.TargetInfo) => boolean) {
    const targets = await this._browser.Target.getTargets({});
    if (!targets) {
      return [];
    }

    return filter ? targets.targetInfos.filter(filter) : targets.targetInfos;
  }

  async closeBrowser(): Promise<void> {
    if (this.launchParams.request === 'launch') {
      if (this.launchParams.cleanUp === 'wholeBrowser') {
        await this._browser.Browser.close({});
        this.process?.kill();
      } else {
        for (const target of this._targets.values()) {
          await this._browser.Target.closeTarget({ targetId: target.targetId });
          this._connection.close();
        }
      }

      this.process = undefined;
    }
  }

  /**
   * Returns a promise that pends until the first target matching the given
   * filter attaches.
   */
  public waitForMainTarget(
    filter?: (target: Cdp.Target.TargetInfo) => boolean,
  ): Promise<BrowserTarget | undefined> {
    let callback: (result: BrowserTarget | undefined) => void;
    const promise = new Promise<BrowserTarget | undefined>(f => (callback = f));
    const attachInner = async (targetInfo: Cdp.Target.TargetInfo) => {
      if (
        [...this._targets.values()].some(t => t.targetId === targetInfo.targetId)
        || this._detachedTargets.has(targetInfo.targetId)
      ) {
        return; // targetInfoChanged on something we're already connected to
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

      callback(this.attachedToTarget(targetInfo, response.sessionId, true));
    };

    this._browser.Target.setDiscoverTargets({ discover: true });

    this._browser.Target.on(
      'targetCreated',
      this.enqueueLifecycleFn(evt => attachInner(evt.targetInfo)),
    );

    this._browser.Target.on(
      'targetInfoChanged',
      evt => this._targetInfoChanged(evt.targetInfo, this.enqueueLifecycleFn(attachInner)),
    );

    this._browser.Target.on(
      'detachedFromTarget',
      this.enqueueLifecycleFn(async event => {
        if (event.targetId) {
          await this._detachedFromTarget(event.sessionId, false);
        }
      }),
    );

    return promise;
  }

  /**
   * Enqueues the function call to be run in the lifecycle of attach and
   * detach events.
   */
  protected enqueueLifecycleFn<T>(fn: (arg: T) => Promise<void>) {
    return (arg: T) => (this._lifecycleQueue = this._lifecycleQueue.then(() => fn(arg)));
  }

  protected attachedToTarget(
    targetInfo: Cdp.Target.TargetInfo,
    sessionId: Cdp.Target.SessionID,
    waitingForDebugger: boolean,
    parentTarget?: BrowserTarget,
    waitForDebuggerOnStart = true,
  ): BrowserTarget {
    const existing = this._targets.get(sessionId);
    if (existing) {
      return existing;
    }

    const cdp = this._connection.createSession(sessionId);
    const target = new BrowserTarget(
      this,
      targetInfo,
      cdp,
      parentTarget,
      waitingForDebugger,
      this.launchParams,
      sessionId,
      this.logger,
      () => {
        this._connection.disposeSession(sessionId);
        this._detachedFromTarget(sessionId);
      },
    );
    this._targets.set(sessionId, target);
    if (parentTarget) parentTarget._children.set(targetInfo.targetId, target);

    cdp.Target.on('attachedToTarget', async event => {
      this.attachedToTarget(event.targetInfo, event.sessionId, event.waitingForDebugger, target);
    });
    cdp.Target.on('detachedFromTarget', async event => {
      if (event.targetId) {
        this._detachedFromTarget(event.sessionId, false);
      }
    });

    cdp.Target.setAutoAttach({ autoAttach: true, waitForDebuggerOnStart, flatten: true });

    cdp.Network.setCacheDisabled({
      cacheDisabled: this.launchParams.disableNetworkCache,
    }).catch(err =>
      this.logger.info(LogTag.RuntimeTarget, 'Error setting network cache state', err)
    );

    // For the 'top-level' page, gather telemetry.
    if (!parentTarget) {
      this.retrieveBrowserTelemetry(cdp);
    }

    const type = targetInfo.type as BrowserTargetType;
    if (domDebuggerTypes.has(type)) this.frameModel.attached(cdp, targetInfo.targetId);
    this.serviceWorkerModel.attached(cdp);

    this._onTargetAddedEmitter.fire(target);

    // For targets that we don't report to the system, auto-resume them on our on.
    // Also for service workers: https://bugs.chromium.org/p/chromium/issues/detail?id=1281013
    if (!jsTypes.has(type) || type === BrowserTargetType.ServiceWorker) {
      target.runIfWaitingForDebugger();
    } else if (type === BrowserTargetType.Page && waitForDebuggerOnStart) {
      cdp.Page.waitForDebugger({});
    }

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

  async _detachedFromTarget(sessionId: string, isStillAttachedInternally = true) {
    const target = this._targets.get(sessionId);
    if (!target) {
      return;
    }

    this._targets.delete(sessionId);
    target.parentTarget?._children.delete(sessionId);

    try {
      await target._detached();
    } catch {
      // ignored -- any network error when we want to detach anyway is fine
    }

    this._onTargetRemovedEmitter.fire(target);
    if (isStillAttachedInternally) {
      this._detachedTargets.add(target.targetId);
      await this._browser.Target.detachFromTarget({ sessionId });
    }

    if (!this._targets.size && this.launchParams.request === 'launch') {
      try {
        if (this.launchParams.cleanUp === 'wholeBrowser') {
          await this._browser.Browser.close({});
        } else {
          await this._browser.Target.closeTarget({ targetId: target.id() });
          this._connection.close();
        }
      } catch {
        // ignored -- any network error when we want to detach anyway is fine
      }
    }
  }

  private async _targetInfoChanged(
    targetInfo: Cdp.Target.TargetInfo,
    attemptAttach: (info: Cdp.Target.TargetInfo) => Promise<void>,
  ) {
    const targets = [...this._targets.values()].filter(t => t.targetId === targetInfo.targetId);

    // if we arent' attach, detach any existing targets and then attempt to
    // re-attach if the conditions are right.
    if (!targetInfo.attached || !targets.length) {
      if (targets.length) {
        await Promise.all(targets.map(t => this._detachedFromTarget(t.sessionId, false)));
      }

      return attemptAttach(targetInfo);
    }

    for (const target of targets) {
      target._updateFromInfo(targetInfo);
    }

    // fire name changes for everyone since this might have caused a duplicate
    // title that we want to disambiguate.
    for (const target of this._targets.values()) {
      if (target.targetId !== targetInfo.targetId) {
        target._onNameChangedEmitter.fire();
      }
    }
  }
}
