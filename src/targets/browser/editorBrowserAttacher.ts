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
import { createTargetFilter, requirePageTarget } from '../../common/urlUtils';
import {
  AnyChromiumConfiguration,
  AnyLaunchConfiguration,
  IEditorBrowserAttachConfiguration,
} from '../../configuration';
import { browserAttachFailed } from '../../dap/errors';
import { ProtocolError } from '../../dap/protocolError';
import { VSCodeApi } from '../../ioc-extras';
import { ILaunchContext, ILauncher, ILaunchResult, IStopMetadata, ITarget } from '../targets';
import { BrowserTargetManager } from './browserTargetManager';
import { BrowserTargetType } from './browserTargets';
import { EditorBrowserSessionTransport } from './editorBrowserSessionTransport';

@injectable()
export class EditorBrowserAttacher implements ILauncher {
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
    if (params.type !== DebugType.EditorBrowser || params.request !== 'attach') {
      return { blockSessionTermination: false };
    }

    if (!this.vscode) {
      throw new ProtocolError(browserAttachFailed('VS Code API is not available'));
    }

    const vscode = this.vscode;
    const { window: vscodeWindow } = vscode;

    const browserTabs = vscodeWindow.browserTabs;
    if (!browserTabs) {
      throw new ProtocolError(
        browserAttachFailed('The browser tab API is not available. Is the proposal enabled?'),
      );
    }

    const attachParams = params as IEditorBrowserAttachConfiguration;
    const urlFilter = attachParams.urlFilter;

    if (urlFilter) {
      const matchesUrl = createTargetFilter(urlFilter);
      const matchingTabs = browserTabs.filter(tab => matchesUrl(tab.url));
      if (matchingTabs.length === 1) {
        return this.attachToTab(matchingTabs[0], params, context);
      }
    }

    type BrowserPickItem = vscodeType.QuickPickItem & {
      tab?: vscodeType.BrowserTab;
      openNew?: true;
    };

    const buildItems = (): BrowserPickItem[] => {
      const matchesUrl = urlFilter ? createTargetFilter(urlFilter) : undefined;
      const activeBrowserTab = vscodeWindow.activeBrowserTab;
      const items: BrowserPickItem[] = [];
      if (activeBrowserTab && (!matchesUrl || matchesUrl(activeBrowserTab.url))) {
        items.push({ label: l10n.t('Active'), kind: vscode.QuickPickItemKind.Separator });
        items.push({
          label: activeBrowserTab.title,
          detail: activeBrowserTab.url,
          iconPath: activeBrowserTab.icon,
          tab: activeBrowserTab,
        });
      }

      const otherTabs = (vscodeWindow.browserTabs ?? [])
        .filter(tab => tab !== activeBrowserTab && (!matchesUrl || matchesUrl(tab.url)));
      if (otherTabs.length > 0) {
        items.push({ label: l10n.t('Other'), kind: vscode.QuickPickItemKind.Separator });
        for (const tab of otherTabs) {
          items.push({
            label: tab.title,
            detail: tab.url,
            iconPath: tab.icon,
            tab,
          });
        }
      }

      items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
      items.push({
        label: l10n.t('Open new\u2026'),
        iconPath: new vscode.ThemeIcon('add'),
        openNew: true,
      });

      return items;
    };

    const selected = await new Promise<BrowserPickItem | undefined>(resolve => {
      const qp = vscode.window.createQuickPick<BrowserPickItem>();
      qp.placeholder = l10n.t('Select a browser tab to debug');
      qp.matchOnDetail = true;
      qp.items = buildItems();

      const disposables: vscodeType.Disposable[] = [];

      const refresh = () => {
        qp.items = buildItems();
      };
      if (vscodeWindow.onDidOpenBrowserTab) {
        disposables.push(vscodeWindow.onDidOpenBrowserTab(refresh));
      }
      if (vscodeWindow.onDidCloseBrowserTab) {
        disposables.push(vscodeWindow.onDidCloseBrowserTab(refresh));
      }
      if (vscodeWindow.onDidChangeActiveBrowserTab) {
        disposables.push(vscodeWindow.onDidChangeActiveBrowserTab(refresh));
      }
      if (vscodeWindow.onDidChangeBrowserTabState) {
        disposables.push(vscodeWindow.onDidChangeBrowserTabState(refresh));
      }

      disposables.push(qp.onDidAccept(() => {
        resolve(qp.selectedItems[0]);
        qp.dispose();
      }));
      disposables.push(qp.onDidHide(() => {
        resolve(undefined);
        qp.dispose();
      }));
      disposables.push(qp);
      disposables.push({ dispose: () => disposables.forEach(d => d.dispose()) });

      qp.show();
    });

    if (!selected) {
      this._onTerminatedEmitter.fire({ killed: true, code: 0 });
      return { blockSessionTermination: false };
    }

    let tab: vscodeType.BrowserTab;
    if (selected.openNew) {
      const url = await vscode.window.showInputBox({
        prompt: l10n.t('Enter a URL to open'),
        placeHolder: 'https://example.com',
        validateInput: value => {
          try {
            new URL(value);
            return undefined;
          } catch {
            return l10n.t('Please enter a valid URL');
          }
        },
      });

      if (!url) {
        this._onTerminatedEmitter.fire({ killed: true, code: 0 });
        return { blockSessionTermination: false };
      }

      if (!vscodeWindow.openBrowserTab) {
        throw new ProtocolError(browserAttachFailed('The browser tab API is not available.'));
      }

      tab = await vscodeWindow.openBrowserTab(url);
    } else {
      tab = selected.tab!;
    }

    return this.attachToTab(tab, params, context);
  }

  private async attachToTab(
    tab: vscodeType.BrowserTab,
    params: AnyLaunchConfiguration,
    context: ILaunchContext,
  ): Promise<ILaunchResult> {
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
      params as unknown as AnyChromiumConfiguration,
      this.logger,
      context.telemetryReporter,
      context.targetOrigin,
    );

    if (!targetManager) {
      connection.close();
      throw new ProtocolError(browserAttachFailed(l10n.t('Could not connect to browser target')));
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

    await targetManager.waitForMainTarget(
      requirePageTarget(t => t.type === BrowserTargetType.Page),
    );

    return { blockSessionTermination: true };
  }

  async terminate(): Promise<void> {
    this._targetManager?.dispose();
    this._targetManager = undefined;
  }

  async restart(): Promise<void> {
    // No-op for attach
  }

  targetList(): ITarget[] {
    return this._targetManager?.targetList() ?? [];
  }
}
