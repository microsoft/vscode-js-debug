/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { expect } from 'chai';
import { stub } from 'sinon';
import Cdp from '../cdp/api';
import Connection from '../cdp/connection';
import { NullTransport } from '../cdp/nullTransport';
import { CdpProtocol } from '../cdp/protocol';
import { Logger } from '../common/logging/logger';
import { upcastPartial } from '../common/objUtils';
import { getDeferred } from '../common/promiseUtil';
import { ISourcePathResolver } from '../common/sourcePathResolver';
import { edgeLaunchConfigDefaults } from '../configuration';
import Dap from '../dap/api';
import { ITarget } from '../targets/targets';
import { NullTelemetryReporter } from '../telemetry/nullTelemetryReporter';
import { ShutdownOrder, ShutdownParticipants } from '../ui/shutdownParticipants';
import { BreakpointManager } from './breakpoints';
import { IEvaluator } from './evaluator';
import { IExceptionPauseService } from './exceptionPauseService';
import { ScriptSkipper } from './scriptSkipper/implementation';
import { SmartStepper } from './smartStepping';
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

describe('Thread interrupted steps', () => {
  const makeCallFrame = (
    scriptId: string,
    lineNumber: number,
    columnNumber = 0,
  ): Cdp.Debugger.CallFrame => ({
    callFrameId: `frame-${scriptId}-${lineNumber}`,
    functionName: '',
    location: { scriptId, lineNumber, columnNumber },
    url: '',
    scopeChain: [],
    this: { type: 'undefined' },
  });

  it('sets a one-shot breakpoint to finish stepOver interrupted by an entry breakpoint', async () => {
    const transport = new NullTransport();
    const connection = new Connection(transport, Logger.null, new NullTelemetryReporter());
    const shutdown = new ShutdownParticipants();
    const stoppedEvents: Dap.StoppedEventParams[] = [];
    const dap = upcastPartial<Dap.Api>({
      loadedSource: stub(),
      thread: stub(),
      stopped: params => {
        stoppedEvents.push(params);
      },
    });
    const config = {
      ...edgeLaunchConfigDefaults,
      sourceMaps: false,
      smartStep: false,
      enableContentValidation: false,
    };
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
    const breakpointManager = upcastPartial<BreakpointManager>({
      executionContextWasCleared: stub(),
      isEntrypointBreak: (ids: string[]) => ids.includes('entry-bp'),
      disableEntrypointBreaks: async () => {},
      shouldPauseAt: async (_event, ids) => ids.length === 0,
      registerBreakpointsHit: stub(),
    });
    const thread = new Thread(
      container,
      connection.rootSession(),
      dap,
      upcastPartial<ITarget>({
        initialize: stub(),
        scriptUrlToUrl: url => url,
        supportsCustomBreakpoints: () => false,
      }),
      upcastPartial({}),
      Logger.null,
      upcastPartial<IEvaluator>({ setReturnedValue: stub() }),
      upcastPartial({}),
      config,
      breakpointManager,
      upcastPartial({}),
      upcastPartial<IExceptionPauseService>({ apply: stub() }),
      upcastPartial<SmartStepper>({ getSmartStepDirection: async () => undefined }),
      shutdown,
      {},
    );
    thread.dapInitialized();

    const sent: Array<{ method: string; params: unknown }> = [];
    transport.onDidSendEmitter.event(msg => {
      if ('id' in msg && 'method' in msg && msg.id !== undefined) {
        const req = msg as CdpProtocol.ICommand;
        sent.push({ method: req.method, params: req.params });
        queueMicrotask(() => {
          const result = req.method === 'Debugger.setBreakpoint'
            ? {
              breakpointId: 'step-resume-bp',
              actualLocation: { scriptId: 'main', lineNumber: 2, columnNumber: 0 },
            }
            : {};
          transport.injectMessage({ id: req.id!, result });
        });
      }
    });

    transport.injectMessage({
      method: 'Runtime.executionContextCreated',
      params: { context: { id: 1, uniqueId: 'ctx-1', name: '', origin: '' } },
    });
    for (const scriptId of ['main', 'mod', 'loader']) {
      transport.injectMessage({
        method: 'Debugger.scriptParsed',
        params: {
          scriptId,
          url: `file:///${scriptId}.js`,
          startLine: 0,
          startColumn: 0,
          endLine: 100,
          endColumn: 0,
          executionContextId: 1,
          hash: scriptId,
          buildId: '',
        },
      });
    }

    const onPaused = (params: Cdp.Debugger.PausedEvent) =>
      (
        thread as unknown as { _onPaused(event: Cdp.Debugger.PausedEvent): Promise<void> }
      )._onPaused(params);

    // Initial pause at main:2 (depth 2)
    await onPaused({
      reason: 'other',
      hitBreakpoints: [],
      callFrames: [makeCallFrame('main', 1, 0), makeCallFrame('loader', 10, 0)],
    });
    stoppedEvents.length = 0;

    // Start stepOver on main:2
    await thread.stepOver();
    sent.length = 0;

    // EntryBreakpoint hits inside mod.js at depth 4 (> targetFrameDepth 2)
    await onPaused({
      reason: 'ambiguous',
      hitBreakpoints: ['entry-bp'],
      callFrames: [
        makeCallFrame('mod', 0, 0),
        makeCallFrame('loader', 50, 0),
        makeCallFrame('main', 1, 12),
        makeCallFrame('loader', 10, 0),
      ],
    });

    expect(sent.map(m => m.method)).to.deep.equal(['Debugger.setBreakpoint', 'Debugger.resume']);
    expect(sent[0].params).to.deep.equal({
      location: { scriptId: 'main', lineNumber: 2, columnNumber: 0 },
    });
    expect(stoppedEvents).to.be.empty;

    // Now the one-shot step-resume breakpoint hits on main:3 (depth 2)
    sent.length = 0;
    await onPaused({
      reason: 'other',
      hitBreakpoints: ['step-resume-bp'],
      callFrames: [makeCallFrame('main', 2, 0), makeCallFrame('loader', 10, 0)],
    });

    expect(sent.map(m => m.method)).to.include('Debugger.removeBreakpoint');
    expect(stoppedEvents).to.have.lengthOf(1);
    expect(stoppedEvents[0].reason).to.equal('step');

    connection.close();
  });
});
