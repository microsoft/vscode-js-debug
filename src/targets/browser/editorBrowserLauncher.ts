/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import { inject, injectable, optional } from 'inversify';
import type * as vscodeType from 'vscode';
import Connection from '../../cdp/connection';
import { DebugType } from '../../common/contributionUtils';
import { EventEmitter } from '../../common/events';
import { ILogger } from '../../common/logging';
import { ISourcePathResolver } from '../../common/sourcePathResolver';
import { requirePageTarget } from '../../common/urlUtils';
import {
  AnyChromiumConfiguration,
  AnyLaunchConfiguration,
  IEditorBrowserLaunchConfiguration,
} from '../../configuration';
import { browserLaunchFailed } from '../../dap/errors';
import { ProtocolError } from '../../dap/protocolError';
import { VSCodeApi } from '../../ioc-extras';
import { ILaunchContext, ILauncher, ILaunchResult, IStopMetadata, ITarget } from '../targets';
import { BrowserTargetManager } from './browserTargetManager';
import { BrowserTargetType } from './browserTargets';
import { EditorBrowserSessionTransport } from './editorBrowserSessionTransport';

@injectable()
export class EditorBrowserLauncher implements ILauncher {
  private _targetManager: BrowserTargetManager | undefined;
  private _onTerminatedEmitter = new EventEmitter<IStopMetadata>();
  readonly onTerminated = this._onTerminatedEmitter.event;
  private _onTargetListChangedEmitter = new EventEmitter<void>();
  readonly onTargetListChanged = this._onTargetListChangedEmitter.event;

  constructor(
    @inject(ILogger) private readonly logger: ILogger,
    @inject(ISourcePathResolver) private readonly pathResolver: ISourcePathResolver,
    @optional() @inject(VSCodeApi) private readonly vscode?: typeof vscodeType,
  ) {}

  public dispose() {
    if (this._targetManager) {
      this._targetManager.dispose();
      this._targetManager = undefined;
    }
  }

  public async launch(
    params: AnyLaunchConfiguration,
    context: ILaunchContext,
  ): Promise<ILaunchResult> {
    if (params.type !== DebugType.EditorBrowser || params.request !== 'launch') {
      return { blockSessionTermination: false };
    }

    if (!this.vscode) {
      throw new ProtocolError(browserLaunchFailed(new Error('VS Code API is not available')));
    }

    const { window: vscodeWindow } = this.vscode;

    if (!vscodeWindow.openBrowserTab) {
      throw new ProtocolError(
        browserLaunchFailed(
          new Error('The browser tab API is not available. Is the proposal enabled?'),
        ),
      );
    }

    const launchParams = params as IEditorBrowserLaunchConfiguration;
    const url = launchParams.url;
    if (!url) {
      throw new ProtocolError(
        browserLaunchFailed(
          new Error(l10n.t('A "url" is required to launch an integrated browser')),
        ),
      );
    }

    // Open the browser tab to about:blank first, then attach the debugger
    // before navigating to the target URL. This mirrors the Chrome/Edge launch
    // flow and ensures early breakpoints and on-load scripts are captured.
    const tab = await vscodeWindow.openBrowserTab('');
    const session = await tab.startCDPSession();

    const transport = new EditorBrowserSessionTransport(session);
    const connection = new Connection(transport, this.logger, context.telemetryReporter);

    connection.onDisconnected(() => {
      this._targetManager?.dispose();
      this._targetManager = undefined;
      this._onTargetListChangedEmitter.fire();
      this._onTerminatedEmitter.fire({ killed: true, code: 0 });
    });

    const targetManager = await BrowserTargetManager.connect(
      connection,
      undefined,
      this.pathResolver,
      { ...launchParams, cleanUp: 'wholeBrowser' } as unknown as AnyChromiumConfiguration,
      this.logger,
      context.telemetryReporter,
      context.targetOrigin,
    );

    if (!targetManager) {
      connection.close();
      throw new ProtocolError(
        browserLaunchFailed(new Error(l10n.t('Could not connect to browser target'))),
      );
    }

    this._targetManager = targetManager;

    targetManager.onTargetAdded(() => this._onTargetListChangedEmitter.fire());
    targetManager.onTargetRemoved(() => {
      this._onTargetListChangedEmitter.fire();
      if (!targetManager.targetList().length) {
        this._onTerminatedEmitter.fire({ killed: true, code: 0 });
        connection.close();
      }
    });

    const mainTarget = await targetManager.waitForMainTarget(
      requirePageTarget(t => t.type === BrowserTargetType.Page),
    );

    // Navigate to the user's URL after the debugger is attached, matching
    // the finishLaunch() behavior in BrowserLauncher for Chrome/Edge.
    if (mainTarget) {
      await mainTarget.cdp().Page.navigate({ url });
    }

    return { blockSessionTermination: true };
  }

  async terminate(): Promise<void> {
    this._targetManager?.dispose();
    this._targetManager = undefined;
  }

  async restart(): Promise<void> {
    // Reload all page targets
    if (!this._targetManager) {
      return;
    }
    for (const target of this._targetManager.targetList()) {
      if (target.type() === 'page') {
        target.restart();
      }
    }
  }

  targetList(): ITarget[] {
    return this._targetManager?.targetList() ?? [];
  }
}
