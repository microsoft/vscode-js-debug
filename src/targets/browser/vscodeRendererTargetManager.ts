/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { URL } from 'url';
import Cdp from '../../cdp/api';
import CdpConnection from '../../cdp/connection';
import { ILogger } from '../../common/logging';
import { ISourcePathResolver } from '../../common/sourcePathResolver';
import { createTargetFilterForConfig, TargetFilter } from '../../common/urlUtils';
import { ITelemetryReporter } from '../../telemetry/telemetryReporter';
import { ITargetOrigin } from '../targetOrigin';
import { BrowserTargetManager } from './browserTargetManager';
import { BrowserTarget, BrowserTargetType } from './browserTargets';
import { IRendererAttachParams } from './vscodeRendererAttacher';

const enum WebviewContentPurpose {
  NotebookRenderer = 'notebookRenderer',
  CustomEditor = 'customEditor',
}

export class VSCodeRendererTargetManager extends BrowserTargetManager {
  /**
   * @override
   */
  static async connectRenderer(
    connection: CdpConnection,
    sourcePathResolver: ISourcePathResolver,
    launchParams: IRendererAttachParams,
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
      undefined,
      browserSession,
      sourcePathResolver,
      logger,
      telemetry,
      launchParams,
      targetOrigin,
    );
  }

  private readonly baseFilter = createTargetFilterForConfig(this.launchParams);

  /**
   * Target filter for interested attachments.
   */
  public readonly filter: TargetFilter = target => {
    const { debugWebWorkerExtHost, debugWebviews } = this.launchParams as IRendererAttachParams;
    if (debugWebWorkerExtHost) {
      if (
        target.type === BrowserTargetType.Worker
        && target.title.startsWith('DebugWorkerExtensionHost')
      ) {
        return true;
      }

      if (
        target.type === BrowserTargetType.Page
        && target.title.includes('[Extension Development Host]')
      ) {
        return true;
      }
    }

    if (debugWebviews && target.type === BrowserTargetType.IFrame && this.baseFilter(target)) {
      return true;
    }

    return false;
  };

  /**
   * @inheritdoc
   */
  public waitForMainTarget(
    filter?: (target: Cdp.Target.TargetInfo) => boolean,
  ): Promise<BrowserTarget | undefined> {
    const params = this.launchParams as IRendererAttachParams;

    if (params.debugWebWorkerExtHost) {
      this._browser.Target.on(
        'targetCreated',
        this.enqueueLifecycleFn(async ({ targetInfo }) => {
          if (!targetInfo.url.includes(params.__sessionId)) {
            return;
          }

          const response = await this._browser.Target.attachToTarget({
            targetId: targetInfo.targetId,
            flatten: true,
          });

          if (response) {
            this.attachedToTarget(targetInfo, response.sessionId, false);
          }
        }),
      );
    }

    return super.waitForMainTarget(filter);
  }

  /**
   * @override
   */
  protected attachedToTarget(
    targetInfo: Cdp.Target.TargetInfo,
    sessionId: Cdp.Target.SessionID,
    waitingForDebugger: boolean,
    parentTarget?: BrowserTarget,
  ): BrowserTarget {
    const target = super.attachedToTarget(
      targetInfo,
      sessionId,
      waitingForDebugger || this.filter(targetInfo),
      parentTarget,
      false,
    );

    if (targetInfo.type === BrowserTargetType.IFrame) {
      target.setComputeNameFn(computeWebviewName);
    }

    return target;
  }
}

const computeWebviewName = (target: BrowserTarget) => {
  let url: URL;
  try {
    url = new URL(target.targetInfo.url);
  } catch {
    return;
  }

  switch (url.searchParams.get('purpose')) {
    case WebviewContentPurpose.CustomEditor:
      return `${url.searchParams.get('extensionId')} editor: ${url.host}`;
    case WebviewContentPurpose.NotebookRenderer:
      return `Notebook Renderer: ${url.host}`;
    default:
      const extensionId = url.searchParams.get('extensionId');
      return `Webview: ${extensionId ? extensionId + ' ' : ''} ${url.host}`;
  }
};
