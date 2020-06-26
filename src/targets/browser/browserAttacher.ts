/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { IDisposable, EventEmitter } from '../../common/events';
import CdpConnection from '../../cdp/connection';
import * as launcher from './launcher';
import * as nls from 'vscode-nls';
import type * as vscodeType from 'vscode';
import { BrowserTargetManager, BrowserTargetType } from './browserTargets';
import { ITarget, ILauncher, ILaunchResult, ILaunchContext, IStopMetadata } from '../targets';
import { AnyLaunchConfiguration, AnyChromiumAttachConfiguration } from '../../configuration';
import { DebugType } from '../../common/contributionUtils';
import { ITelemetryReporter } from '../../telemetry/telemetryReporter';
import { createTargetFilterForConfig, TargetFilter } from '../../common/urlUtils';
import { delay } from '../../common/promiseUtil';
import { CancellationToken } from 'vscode';
import { NeverCancelled } from '../../common/cancellation';
import { ILogger } from '../../common/logging';
import { injectable, inject, optional } from 'inversify';
import { ISourcePathResolver } from '../../common/sourcePathResolver';
import { VSCodeApi } from '../../ioc-extras';
import { browserAttachFailed, targetPageNotFound, ProtocolError } from '../../dap/errors';

const localize = nls.loadMessageBundle();

@injectable()
export class BrowserAttacher implements ILauncher {
  private _attemptTimer: NodeJS.Timer | undefined;
  private _connection: CdpConnection | undefined;
  private _targetManager: BrowserTargetManager | undefined;
  private _disposables: IDisposable[] = [];
  protected _lastLaunchParams?: AnyChromiumAttachConfiguration;
  private _onTerminatedEmitter = new EventEmitter<IStopMetadata>();
  readonly onTerminated = this._onTerminatedEmitter.event;
  private _onTargetListChangedEmitter = new EventEmitter<void>();
  readonly onTargetListChanged = this._onTargetListChangedEmitter.event;

  constructor(
    @inject(ILogger) protected readonly logger: ILogger,
    @inject(ISourcePathResolver) private readonly pathResolver: ISourcePathResolver,
    @optional() @inject(VSCodeApi) private readonly vscode?: typeof vscodeType,
  ) {}

  /**
   * @inheritdoc
   */
  public dispose() {
    for (const disposable of this._disposables) disposable.dispose();
    this._disposables = [];
    if (this._attemptTimer) clearTimeout(this._attemptTimer);
    if (this._targetManager) this._targetManager.dispose();
  }

  /**
   * @inheritdoc
   */
  public async launch(
    params: AnyLaunchConfiguration,
    context: ILaunchContext,
  ): Promise<ILaunchResult> {
    if (
      (params.type !== DebugType.Chrome && params.type !== DebugType.Edge) ||
      params.request !== 'attach'
    ) {
      return { blockSessionTermination: false };
    }

    this._lastLaunchParams = { ...params, timeout: Infinity };

    await this._attemptToAttach(this._lastLaunchParams, context);
    return { blockSessionTermination: true };
  }

  /**
   * Schedules an attempt to reconnect after a short timeout.
   */
  private _scheduleAttach(params: AnyChromiumAttachConfiguration, context: ILaunchContext) {
    this._attemptTimer = setTimeout(() => {
      this._attemptTimer = undefined;
      this._attemptToAttach(params, { ...context, cancellationToken: NeverCancelled });
    }, 1000);
  }

  /**
   * Creates the target manager for handling the given connection.
   */
  protected createTargetManager(
    connection: CdpConnection,
    params: AnyChromiumAttachConfiguration,
    context: ILaunchContext,
  ) {
    return BrowserTargetManager.connect(
      connection,
      undefined,
      this.pathResolver,
      params,
      this.logger,
      context.telemetryReporter,
      context.targetOrigin,
    );
  }

  /**
   * Attempts to attach to the target. Returns an error in a string if the
   * connection was not successful.
   */
  private async _attemptToAttach(params: AnyChromiumAttachConfiguration, context: ILaunchContext) {
    const connection = await this.acquireConnectionForBrowser(
      context.telemetryReporter,
      params,
      context.cancellationToken,
    );

    this._connection = connection;
    connection.onDisconnected(
      () => {
        this._connection = undefined;
        if (this._targetManager) {
          this._targetManager.dispose();
          this._targetManager = undefined;
          this._onTargetListChangedEmitter.fire();
        }

        if (this._lastLaunchParams === params && params.restart) {
          this._scheduleAttach(params, context);
        } else {
          this._onTerminatedEmitter.fire({ killed: true, code: 0 });
        }
      },
      undefined,
      this._disposables,
    );

    const targetManager = (this._targetManager = await this.createTargetManager(
      connection,
      params,
      context,
    ));

    if (!targetManager) {
      return;
    }

    targetManager.serviceWorkerModel.onDidChange(() => this._onTargetListChangedEmitter.fire());
    targetManager.frameModel.onFrameNavigated(() => this._onTargetListChangedEmitter.fire());
    targetManager.onTargetAdded(() => {
      this._onTargetListChangedEmitter.fire();
    });
    targetManager.onTargetRemoved(() => {
      this._onTargetListChangedEmitter.fire();
      if (!targetManager.targetList().length) {
        // graceful exit
        this._onTerminatedEmitter.fire({ killed: true, code: 0 });
      }
    });

    const result = await Promise.race([
      targetManager.waitForMainTarget(await this.getTargetFilter(targetManager, params)),
      delay(params.timeout).then(() => {
        throw new ProtocolError(targetPageNotFound());
      }),
    ]);

    return typeof result === 'string' ? result : undefined;
  }

  /**
   * Gets the filter function to pick which target to attach to.
   */
  protected async getTargetFilter(
    manager: BrowserTargetManager,
    params: AnyChromiumAttachConfiguration,
  ): Promise<TargetFilter> {
    const rawFilter = createTargetFilterForConfig(params);
    const baseFilter: TargetFilter = t => t.type === BrowserTargetType.Page && rawFilter(t);
    if (params.targetSelection !== 'pick') {
      return baseFilter;
    }

    const targets = await manager.getCandiateInfo(baseFilter);
    if (targets.length === 0) {
      return baseFilter;
    }

    if (targets.length === 1 || !this.vscode) {
      return target => target.targetId === targets[0].targetId;
    }

    const placeHolder = localize('chrome.targets.placeholder', 'Select a tab');
    const selected = await this.vscode.window.showQuickPick(
      targets.map(target => ({
        label: target.title,
        detail: target.url,
        targetId: target.targetId,
      })),
      { matchOnDescription: true, matchOnDetail: true, placeHolder },
    );

    if (!selected) {
      return baseFilter;
    }

    return target => target.targetId === selected.targetId;
  }

  /**
   * Gets a CDP connection to the browser.
   */
  private async acquireConnectionForBrowser(
    rawTelemetryReporter: ITelemetryReporter,
    params: AnyChromiumAttachConfiguration,
    cancellationToken: CancellationToken,
  ) {
    while (this._lastLaunchParams === params) {
      try {
        return await this.acquireConnectionInner(rawTelemetryReporter, params, cancellationToken);
      } catch (e) {
        if (cancellationToken.isCancellationRequested) {
          throw new ProtocolError(
            browserAttachFailed(
              localize(
                'attach.cannotConnect',
                'Cannot connect to the target at {0}: {1}',
                `${params.address}:${params.port}`,
                e.message,
              ),
            ),
          );
        }

        await delay(1000);
      }
    }

    throw new ProtocolError(
      browserAttachFailed(
        localize(
          'attach.cannotConnect',
          'Cannot connect to the target at {0}: {1}',
          `${params.address}:${params.port}`,
          'Cancelled',
        ),
      ),
    );
  }

  /**
   * Inner method to get a CDP connection to the browser. May fail early, but
   * should throw if cancellation is required.
   */
  protected async acquireConnectionInner(
    rawTelemetryReporter: ITelemetryReporter,
    params: AnyChromiumAttachConfiguration,
    cancellationToken: CancellationToken,
  ) {
    const browserURL = `http://${params.address}:${params.port}`;
    return await launcher.attach(
      { browserURL, inspectUri: params.inspectUri, pageURL: params.url },
      cancellationToken,
      this.logger,
      rawTelemetryReporter,
    );
  }

  async terminate(): Promise<void> {
    this._lastLaunchParams = undefined;
    this._connection?.close();
  }

  public disconnect(): Promise<void> {
    return this.terminate();
  }

  async restart(): Promise<void> {
    // no-op
  }

  targetList(): ITarget[] {
    const manager = this._targetManager;
    return manager ? manager.targetList() : [];
  }
}
