/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import { randomUUID } from 'crypto';
import { inject, injectable, optional } from 'inversify';
import type * as vscodeType from 'vscode';
import { CancellationToken } from 'vscode';
import CdpConnection from '../../cdp/connection';
import { WebSocketTransport } from '../../cdp/webSocketTransport';
import { CancellationTokenSource, NeverCancelled } from '../../common/cancellation';
import { DebugType } from '../../common/contributionUtils';
import { EventEmitter, IDisposable } from '../../common/events';
import { ILogger } from '../../common/logging';
import { delay } from '../../common/promiseUtil';
import { ISourcePathResolver } from '../../common/sourcePathResolver';
import {
  createTargetFilterForConfig,
  requirePageTarget,
  TargetFilter,
} from '../../common/urlUtils';
import { AnyChromiumAttachConfiguration, AnyLaunchConfiguration } from '../../configuration';
import Dap from '../../dap/api';
import { browserAttachFailed, createSilentError, targetPageNotFound } from '../../dap/errors';
import { ProtocolError } from '../../dap/protocolError';
import { VSCodeApi } from '../../ioc-extras';
import { ITelemetryReporter } from '../../telemetry/telemetryReporter';
import { ILaunchContext, ILauncher, ILaunchResult, IStopMetadata, ITarget } from '../targets';
import { BrowserTargetManager } from './browserTargetManager';
import { BrowserTargetType } from './browserTargets';
import * as launcher from './launcher';
import { findDevToolsActivePortEndpoint } from './spawn/endpoints';

@injectable()
export class BrowserAttacher<
  T extends AnyChromiumAttachConfiguration = AnyChromiumAttachConfiguration,
> implements ILauncher {
  private _attemptTimer: NodeJS.Timeout | undefined;
  private _connection: CdpConnection | undefined;
  private _targetManager: BrowserTargetManager | undefined;
  private _disposables: IDisposable[] = [];
  private readonly _approvalCts = new CancellationTokenSource();
  protected _lastLaunchParams?: T;
  private _onTerminatedEmitter = new EventEmitter<IStopMetadata>();
  readonly onTerminated = this._onTerminatedEmitter.event;
  private _onTargetListChangedEmitter = new EventEmitter<void>();
  readonly onTargetListChanged = this._onTargetListChangedEmitter.event;
  protected closeWhenTargetsEmpty = true;

  constructor(
    @inject(ILogger) protected readonly logger: ILogger,
    @inject(ISourcePathResolver) private readonly pathResolver: ISourcePathResolver,
    @optional() @inject(VSCodeApi) private readonly vscode?: typeof vscodeType,
  ) {}

  /**
   * @inheritdoc
   */
  public dispose() {
    this._approvalCts.dispose(true);
    for (const disposable of this._disposables) disposable.dispose();
    this._disposables = [];
    if (this._attemptTimer) clearTimeout(this._attemptTimer);
    if (this._targetManager) this._targetManager.dispose();
  }

  /**
   * Returns whether the params is an attach configuration that this attacher can handle.
   */
  protected resolveParams(params: AnyLaunchConfiguration): params is T {
    return (
      params.request === 'attach'
      && (params.type === DebugType.Chrome
        || (params.type === DebugType.Edge && typeof params.useWebView !== 'object'))
      && params.browserAttachLocation === 'workspace'
    );
  }

  /**
   * @inheritdoc
   */
  public async launch(
    params: AnyLaunchConfiguration,
    context: ILaunchContext,
  ): Promise<ILaunchResult> {
    const resolved = this.resolveParams(params);
    if (!resolved) {
      return { blockSessionTermination: false };
    }

    this._lastLaunchParams = { ...params, timeout: Infinity } as T;

    await this.attemptToAttach(this._lastLaunchParams, context);
    return { blockSessionTermination: true };
  }

  /**
   * Schedules an attempt to reconnect after a short timeout.
   */
  private _scheduleAttach(params: T, context: ILaunchContext) {
    this._attemptTimer = setTimeout(() => {
      this._attemptTimer = undefined;
      this.attemptToAttach(params, { ...context, cancellationToken: NeverCancelled });
    }, 1000);
  }

  /**
   * Creates the target manager for handling the given connection.
   */
  protected createTargetManager(connection: CdpConnection, params: T, context: ILaunchContext) {
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
  private async attemptToAttach(params: T, context: ILaunchContext) {
    const connection = await this.acquireConnectionForBrowser(context, params);

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
      if (!targetManager.targetList().length && this.closeWhenTargetsEmpty) {
        // graceful exit
        this._onTerminatedEmitter.fire({ killed: true, code: 0 });
        this._connection?.close();
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
    const baseFilter = requirePageTarget(rawFilter);
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

    const placeHolder = l10n.t('Select a tab');
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
  protected async acquireConnectionForBrowser(
    { telemetryReporter, cancellationToken, dap }: ILaunchContext,
    params: AnyChromiumAttachConfiguration,
  ): Promise<CdpConnection> {
    while (this._lastLaunchParams === params) {
      try {
        return await this.acquireConnectionInner(telemetryReporter, params, cancellationToken, dap);
      } catch (e) {
        if (e instanceof ProtocolError) {
          throw e;
        }

        if (cancellationToken.isCancellationRequested) {
          throw new ProtocolError(
            browserAttachFailed(
              l10n.t(
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
        l10n.t(
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
    dap: Dap.Api,
  ) {
    const browserURL = `http://${params.address}:${params.port}`;
    const traditionalCts = new CancellationTokenSource(cancellationToken);
    // Approval must not inherit the launch timeout.
    const approvalCts = new CancellationTokenSource(this._approvalCts.token);
    let connected = false;
    const accept = (connection: CdpConnection, loser: CancellationTokenSource) => {
      if (connected) {
        connection.close();
      } else {
        connected = true;
        loser.cancel();
      }
      return connection;
    };

    const traditional = launcher.attach(
      { browserURL, inspectUri: params.inspectUri, pageURL: params.url },
      traditionalCts.token,
      this.logger,
      rawTelemetryReporter,
    ).then(connection => accept(connection, approvalCts));
    const approval = (async () => {
      const endpoint = await findDevToolsActivePortEndpoint(
        params.address,
        params.port,
        params.userDataDir,
        this.logger,
      );
      if (!endpoint) {
        throw new Error('Approval-based browser attachment unavailable.');
      }

      const transport = await this.connectWithApproval(endpoint, dap, approvalCts);
      return new CdpConnection(transport, this.logger, rawTelemetryReporter);
    })().then(
      connection => accept(connection, traditionalCts),
      error => {
        // the user cancelled the approval, so cancel the whole attach
        if (error instanceof ProtocolError) {
          traditionalCts.cancel();
        }
        throw error;
      },
    );

    try {
      return await Promise.any([traditional, approval]).catch((e: AggregateError) => {
        throw e.errors.find(e => e instanceof ProtocolError) ?? e.errors[0];
      });
    } finally {
      traditionalCts.dispose();
      approvalCts.dispose();
    }
  }

  private async connectWithApproval(url: string, dap: Dap.Api, cts: CancellationTokenSource) {
    if (cts.token.isCancellationRequested) {
      throw new Error('Browser attachment cancelled.');
    }

    const progressId = randomUUID();
    let userCancelled = false;
    const disposeCancel = dap.on('cancel', async params => {
      if (params.progressId === progressId && !cts.token.isCancellationRequested) {
        userCancelled = true;
        cts.cancel();
      }
      return {};
    });

    try {
      dap.progressStart({
        progressId,
        title: l10n.t('Waiting for browser approval'),
        message: l10n.t('Approve the remote debugging request in your browser to continue.'),
        cancellable: true,
      });

      return await WebSocketTransport.open(url, cts.token);
    } catch (e) {
      if (userCancelled) {
        throw new ProtocolError(createSilentError(l10n.t('Browser attachment was cancelled.')));
      }
      throw e;
    } finally {
      disposeCancel();
      dap.progressEnd({ progressId });
    }
  }

  async terminate(): Promise<void> {
    this._lastLaunchParams = undefined;
    this._approvalCts.cancel();
    this._connection?.close();
  }

  async restart(): Promise<void> {
    if (!this._targetManager) {
      return;
    }

    for (const target of this._targetManager.targetList()) {
      // fix: exclude devtools from reload (#1058)
      if (target.type() === BrowserTargetType.Page && !target.name().startsWith('devtools://')) {
        target.restart();
      }
    }
  }

  targetList(): ITarget[] {
    const manager = this._targetManager;
    return manager ? manager.targetList() : [];
  }
}
