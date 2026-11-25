/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { expect } from 'chai';
import { stub } from 'sinon';
import Cdp from '../cdp/api';
import Connection from '../cdp/connection';
import { NullTransport } from '../cdp/nullTransport';
import { DebugType } from '../common/contributionUtils';
import { Logger } from '../common/logging/logger';
import { upcastPartial } from '../common/objUtils';
import { getDeferred } from '../common/promiseUtil';
import { ISourcePathResolver } from '../common/sourcePathResolver';
import {
  AnyLaunchConfiguration,
  edgeLaunchConfigDefaults,
  extensionHostConfigDefaults,
} from '../configuration';
import Dap from '../dap/api';
import * as errors from '../dap/errors';
import { ITarget } from '../targets/targets';
import { NullTelemetryReporter } from '../telemetry/nullTelemetryReporter';
import { ShutdownOrder, ShutdownParticipants } from '../ui/shutdownParticipants';
import { BreakpointManager } from './breakpoints';
import { IExceptionPauseService } from './exceptionPauseService';
import { ScriptSkipper } from './scriptSkipper/implementation';
import { SourceContainer } from './sourceContainer';
import { Thread } from './threads';

describe('Thread execution contexts', () => {
  const contextId = 1;
  const authScript = 'http://localhost/auth.js';
  let transport: NullTransport;
  let connection: Connection;
  let container: SourceContainer;
  let thread: Thread;
  let drained: ReturnType<typeof getDeferred<void>>;

  beforeEach(() => {
    transport = new NullTransport();
    connection = new Connection(transport, Logger.null, new NullTelemetryReporter());
    const shutdown = new ShutdownParticipants();
    drained = getDeferred<void>();
    shutdown.register(ShutdownOrder.ExecutionContexts, () => drained.promise);
    const dap = upcastPartial<Dap.Api>({ loadedSource: stub(), thread: stub() });
    const config = {
      ...edgeLaunchConfigDefaults,
      sourceMaps: false,
      enableContentValidation: true,
    };
    container = new SourceContainer(
      dap,
      upcastPartial({}),
      Logger.null,
      config,
      upcastPartial({}),
      upcastPartial<ISourcePathResolver>({ urlToAbsolutePath: async () => undefined }),
      upcastPartial<ScriptSkipper>({
        setSourceContainer: stub(),
        initializeSkippingValueForSource: stub(),
      }),
      upcastPartial({}),
      upcastPartial({}),
    );
    thread = new Thread(
      container,
      connection.rootSession(),
      dap,
      upcastPartial<ITarget>({ initialize: stub(), scriptUrlToUrl: url => url }),
      upcastPartial({}),
      Logger.null,
      upcastPartial({}),
      upcastPartial({}),
      config,
      upcastPartial<BreakpointManager>({ executionContextWasCleared: stub() }),
      upcastPartial({}),
      upcastPartial<IExceptionPauseService>({ apply: stub() }),
      upcastPartial({}),
      shutdown,
      {},
    );
  });

  afterEach(() => connection.close());

  const announceContext = (uniqueId: string) => {
    const params: Cdp.Runtime.ExecutionContextCreatedEvent = {
      context: { id: contextId, uniqueId, name: '', origin: '' },
    };
    transport.injectMessage({ method: 'Runtime.executionContextCreated', params });
  };

  const announceScript = (scriptId: string, url: string) => {
    const params: Cdp.Debugger.ScriptParsedEvent = {
      scriptId,
      url,
      startLine: 0,
      startColumn: 0,
      endLine: 100,
      endColumn: 0,
      executionContextId: contextId,
      hash: url,
      buildId: '',
    };
    transport.injectMessage({ method: 'Debugger.scriptParsed', params });
  };

  it('maps paused locations to the new script when a navigation reuses both CDP IDs', async () => {
    const previousPage = 'https://example.com/authorize';
    const location = { scriptId: '8', lineNumber: 72, columnNumber: 21 };
    announceContext('before');
    announceScript(location.scriptId, previousPage);
    expect((await thread.rawLocationToUiLocation(location))?.source.url).to.equal(previousPage);

    const cleanup = thread._executionContextsCleared();
    announceContext('after');
    announceScript(location.scriptId, authScript);

    const resolved = await thread.rawLocationToUiLocation(location);
    expect(resolved?.source.url).to.equal(authScript);
    expect(resolved).to.include({ lineNumber: 72, columnNumber: 21 });

    drained.resolve();
    await cleanup;
    expect((await thread.rawLocationToUiLocation(location))?.source).to.equal(resolved?.source);
  });

  it('keeps the new script on a shared source when an old context finishes cleanup', async () => {
    announceContext('before');
    announceScript('8', authScript);
    const source = await container.getScriptById('8')?.source;

    const cleanup = thread._executionContextsCleared();
    announceContext('after');
    announceScript('9', authScript);
    expect(await container.getScriptById('9')?.source).to.equal(source);
    drained.resolve();
    await cleanup;

    expect(container.getSourceByOriginalUrl(authScript)).to.equal(source);
    expect(source?.scripts.map(script => script.scriptId)).to.deep.equal(['9']);
    expect(container.getScriptById('8')).to.be.undefined;
  });
});

describe('Thread enableNetworking', () => {
  const createThread = (config: AnyLaunchConfiguration) => {
    const transport = new NullTransport();
    const connection = new Connection(transport, Logger.null, new NullTelemetryReporter());
    const shutdown = new ShutdownParticipants();
    const dap = upcastPartial<Dap.Api>({ loadedSource: stub(), thread: stub() });
    const container = new SourceContainer(
      dap,
      upcastPartial({}),
      Logger.null,
      config,
      upcastPartial({}),
      upcastPartial<ISourcePathResolver>({ urlToAbsolutePath: async () => undefined }),
      upcastPartial<ScriptSkipper>({
        setSourceContainer: stub(),
        initializeSkippingValueForSource: stub(),
      }),
      upcastPartial({}),
      upcastPartial({}),
    );
    const thread = new Thread(
      container,
      connection.rootSession(),
      dap,
      upcastPartial<ITarget>({ initialize: stub(), scriptUrlToUrl: url => url }),
      upcastPartial({}),
      Logger.null,
      upcastPartial({}),
      upcastPartial({}),
      config,
      upcastPartial<BreakpointManager>({ executionContextWasCleared: stub() }),
      upcastPartial({}),
      upcastPartial<IExceptionPauseService>({ apply: stub() }),
      upcastPartial({}),
      shutdown,
      {},
    );
    return { transport, connection, thread };
  };

  it('rejects without calling Network.enable for extensionHost sessions', async () => {
    const { transport, connection, thread } = createThread({
      ...extensionHostConfigDefaults,
      type: DebugType.ExtensionHost,
    });
    const sentMethods: string[] = [];
    transport.onDidSendEmitter.event(msg => {
      if ('method' in msg && msg.method) {
        sentMethods.push(msg.method);
      }
    });

    let err: unknown;
    try {
      await thread.enableNetworking({ mirrorEvents: [] });
    } catch (e) {
      err = e;
    }

    expect(err).to.deep.equal(errors.networkingNotAvailable());
    expect(sentMethods).to.not.include('Network.enable');
    connection.close();
  });

  it('calls Network.enable for non-extensionHost sessions', async () => {
    const { transport, connection, thread } = createThread(edgeLaunchConfigDefaults);
    const sentMethods: string[] = [];
    transport.onDidSendEmitter.event(msg => {
      if ('id' in msg && 'method' in msg && msg.id !== undefined) {
        sentMethods.push(msg.method!);
        queueMicrotask(() => {
          transport.injectMessage({ id: msg.id!, result: {} });
        });
      }
    });

    const result = await thread.enableNetworking({ mirrorEvents: [] });
    expect(result).to.deep.equal({});
    expect(sentMethods).to.include('Network.enable');
    connection.close();
  });
});
