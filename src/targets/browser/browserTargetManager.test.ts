/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { expect } from 'chai';
import Cdp from '../../cdp/api';
import Connection from '../../cdp/connection';
import { NullTransport } from '../../cdp/nullTransport';
import { CdpProtocol } from '../../cdp/protocol';
import { DebugType } from '../../common/contributionUtils';
import { Logger } from '../../common/logging/logger';
import { upcastPartial } from '../../common/objUtils';
import { ISourcePathResolver } from '../../common/sourcePathResolver';
import {
  AnyChromiumConfiguration,
  applyDefaults,
  chromeAttachConfigDefaults,
} from '../../configuration';
import { NullTelemetryReporter } from '../../telemetry/nullTelemetryReporter';
import { TargetOrigin } from '../targetOrigin';
import { BrowserTargetManager } from './browserTargetManager';
import { BrowserTarget } from './browserTargets';
import { IRendererAttachParams } from './vscodeRendererAttacher';
import { VSCodeRendererTargetManager } from './vscodeRendererTargetManager';

describe('BrowserTargetManager', () => {
  const makeTargetInfo = (
    overrides: Partial<Cdp.Target.TargetInfo> & Pick<Cdp.Target.TargetInfo, 'targetId' | 'type'>,
  ): Cdp.Target.TargetInfo => ({
    title: overrides.targetId,
    url: 'https://example.com/',
    attached: false,
    canAccessOpener: false,
    ...overrides,
  });

  const setup = async <T extends BrowserTargetManager>(
    createManager: (
      connection: Connection,
      browserSession: Cdp.Api,
      pathResolver: ISourcePathResolver,
      logger: Logger,
      telemetry: NullTelemetryReporter,
      origin: TargetOrigin,
    ) => T,
  ) => {
    const transport = new NullTransport();
    const logger = Logger.null;
    const telemetry = new NullTelemetryReporter();
    const connection = new Connection(transport, logger, telemetry);
    const pathResolver = upcastPartial<ISourcePathResolver>({});
    const origin = new TargetOrigin('test-origin');

    transport.onDidSendEmitter.event(msg => {
      if ('id' in msg && 'method' in msg && msg.id !== undefined) {
        const req = msg as CdpProtocol.ICommand & { id: number };
        queueMicrotask(() => {
          transport.injectMessage({
            id: req.id,
            sessionId: req.sessionId,
            result: req.method === 'Target.attachToTarget' ? { sessionId: 'page-session' } : {},
          });
        });
      }
    });

    const browserSession = connection.createSession('browser-session');
    const manager = createManager(
      connection,
      browserSession,
      pathResolver,
      logger,
      telemetry,
      origin,
    );
    const added: BrowserTarget[] = [];
    manager.onTargetAdded(target => added.push(target));

    const mainPromise = manager.waitForMainTarget();
    transport.injectMessage({
      method: 'Target.targetCreated',
      sessionId: 'browser-session',
      params: {
        targetInfo: makeTargetInfo({ targetId: 'page-1', type: 'page' }),
      },
    });

    const mainTarget = await mainPromise;
    expect(mainTarget).to.exist;
    await mainTarget!.attach();
    await mainTarget!.afterBind();

    return { transport, manager, mainTarget: mainTarget!, added };
  };

  it('marks existing JS child targets as waitingForDebugger when attaching to an open page', async () => {
    const { transport, manager, added } = await setup(
      (connection, browserSession, pathResolver, logger, telemetry, origin) =>
        new BrowserTargetManager(
          connection,
          undefined,
          browserSession,
          pathResolver,
          logger,
          telemetry,
          chromeAttachConfigDefaults,
          origin,
        ),
    );

    transport.injectMessage({
      method: 'Target.attachedToTarget',
      sessionId: 'page-session',
      params: {
        sessionId: 'iframe-session',
        targetInfo: makeTargetInfo({ targetId: 'iframe-1', type: 'iframe', attached: true }),
        waitingForDebugger: false,
      },
    });

    const iframeTarget = added.find(t => t.targetId === 'iframe-1');
    expect(iframeTarget).to.exist;
    expect(iframeTarget!.waitingForDebugger()).to.be.true;

    // Simulate Binder attaching the iframe target and unpausing its CDP session, then a nested existing worker attaching
    await iframeTarget!.attach();
    await iframeTarget!.afterBind();

    transport.injectMessage({
      method: 'Target.attachedToTarget',
      sessionId: 'iframe-session',
      params: {
        sessionId: 'worker-session',
        targetInfo: makeTargetInfo({ targetId: 'worker-1', type: 'worker', attached: true }),
        waitingForDebugger: false,
      },
    });

    const workerTarget = added.find(t => t.targetId === 'worker-1');
    expect(workerTarget).to.exist;
    expect(workerTarget!.waitingForDebugger()).to.be.true;
    expect(workerTarget!.parent()).to.equal(iframeTarget);
    expect(manager.targetList().map(t => t.targetId)).to.deep.equal([
      'page-1',
      'iframe-1',
      'worker-1',
    ]);
  });

  it('does not mark non-JS child targets as waitingForDebugger when waitingForDebugger is false', async () => {
    const { transport, manager, added } = await setup(
      (connection, browserSession, pathResolver, logger, telemetry, origin) =>
        new BrowserTargetManager(
          connection,
          undefined,
          browserSession,
          pathResolver,
          logger,
          telemetry,
          chromeAttachConfigDefaults as AnyChromiumConfiguration,
          origin,
        ),
    );

    transport.injectMessage({
      method: 'Target.attachedToTarget',
      sessionId: 'page-session',
      params: {
        sessionId: 'other-session',
        targetInfo: makeTargetInfo({ targetId: 'other-1', type: 'other', attached: true }),
        waitingForDebugger: false,
      },
    });

    const otherTarget = added.find(t => t.targetId === 'other-1');
    expect(otherTarget).to.exist;
    expect(otherTarget!.waitingForDebugger()).to.be.false;
    expect(manager.targetList().map(t => t.targetId)).to.deep.equal(['page-1']);
  });

  it('preserves filter selectivity in VSCodeRendererTargetManager for existing child targets', async () => {
    const rendererParams: IRendererAttachParams = {
      ...(applyDefaults({
        name: 'Webview',
        type: DebugType.Chrome,
        request: 'attach',
        urlFilter: '*included*',
      }) as IRendererAttachParams),
      __sessionId: 'ext-host-session',
      debugWebviews: true,
      debugWebWorkerExtHost: false,
    };

    const { transport, added } = await setup(
      (connection, browserSession, pathResolver, logger, telemetry, origin) =>
        new VSCodeRendererTargetManager(
          connection,
          undefined,
          browserSession,
          pathResolver,
          logger,
          telemetry,
          rendererParams,
          origin,
        ),
    );

    transport.injectMessage({
      method: 'Target.attachedToTarget',
      sessionId: 'page-session',
      params: {
        sessionId: 'ignored-iframe-session',
        targetInfo: makeTargetInfo({
          targetId: 'ignored-iframe',
          type: 'iframe',
          url: 'https://unrelated.example/',
          attached: true,
        }),
        waitingForDebugger: false,
      },
    });

    transport.injectMessage({
      method: 'Target.attachedToTarget',
      sessionId: 'page-session',
      params: {
        sessionId: 'matched-iframe-session',
        targetInfo: makeTargetInfo({
          targetId: 'matched-iframe',
          type: 'iframe',
          url: 'https://included.example/',
          attached: true,
        }),
        waitingForDebugger: false,
      },
    });

    expect(added.find(t => t.targetId === 'ignored-iframe')!.waitingForDebugger()).to.be.false;
    expect(added.find(t => t.targetId === 'matched-iframe')!.waitingForDebugger()).to.be.true;
  });
});
