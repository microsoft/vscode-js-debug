/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { expect } from 'chai';
import { SinonStub, stub } from 'sinon';
import Cdp from '../cdp/api';
import { stubbedCdpApi, StubCdpApi } from '../cdp/stubbedApi';
import { upcastPartial } from '../common/objUtils';
import { AnyLaunchConfiguration } from '../configuration';
import Dap from '../dap/api';
import { stubbedDapApi, StubDapApi } from '../dap/stubbedApi';
import { assertNotResolved, assertResolved } from '../test/asserts';
import { IEvaluator } from './evaluator';
import { ExceptionPauseService, PauseOnExceptionsState } from './exceptionPauseService';
import { ScriptSkipper } from './scriptSkipper/implementation';

describe('ExceptionPauseService', () => {
  let prepareEval: SinonStub;
  let isScriptSkipped: SinonStub;
  let ep: ExceptionPauseService;
  let stubDap: StubDapApi;
  let stubCdp: StubCdpApi;

  beforeEach(() => {
    prepareEval = stub();
    isScriptSkipped = stub().returns(false);
    stubDap = stubbedDapApi();
    stubCdp = stubbedCdpApi();
    ep = new ExceptionPauseService(
      upcastPartial<IEvaluator>({ prepare: prepareEval }),
      upcastPartial<ScriptSkipper>({ isScriptSkipped }),
      stubDap as unknown as Dap.Api,
      upcastPartial<AnyLaunchConfiguration>({}),
    );
  });

  it('does not set pause state when bps not configured', async () => {
    await ep.apply(stubCdp.actual);
    expect(stubCdp.Debugger.setPauseOnExceptions.callCount).to.equal(0);
    await assertResolved(ep.launchBlocker);
  });

  it('sets breakpoints in cdp before binding', async () => {
    await ep.setBreakpoints({ filters: [PauseOnExceptionsState.All] });
    await assertNotResolved(ep.launchBlocker);
    await ep.apply(stubCdp.actual);
    expect(stubCdp.Debugger.setPauseOnExceptions.calledWith({ state: 'all' })).to.be.true;
    await assertResolved(ep.launchBlocker);
  });

  it('sets breakpoints in cdp after binding', async () => {
    await ep.apply(stubCdp.actual);
    await ep.setBreakpoints({ filters: [PauseOnExceptionsState.All] });
    expect(stubCdp.Debugger.setPauseOnExceptions.calledWith({ state: 'all' })).to.be.true;
    await assertResolved(ep.launchBlocker);
  });

  it('unsets pause state', async () => {
    await ep.apply(stubCdp.actual);
    await ep.setBreakpoints({ filters: [PauseOnExceptionsState.All] });
    expect(stubCdp.Debugger.setPauseOnExceptions.calledWith({ state: 'all' })).to.be.true;
    await ep.setBreakpoints({ filters: [PauseOnExceptionsState.None] });
    expect(stubCdp.Debugger.setPauseOnExceptions.calledWith({ state: 'none' })).to.be.true;
  });

  it('changes pause state', async () => {
    await ep.apply(stubCdp.actual);
    await ep.setBreakpoints({ filters: [PauseOnExceptionsState.All] });
    expect(stubCdp.Debugger.setPauseOnExceptions.calledWith({ state: 'all' })).to.be.true;
    await ep.setBreakpoints({ filters: [PauseOnExceptionsState.Uncaught] });
    expect(stubCdp.Debugger.setPauseOnExceptions.calledWith({ state: 'uncaught' })).to.be.true;
  });

  it('prints an error on conditional breakpoint parse error', async () => {
    await ep.apply(stubCdp.actual);
    await ep.setBreakpoints({
      filters: [],
      filterOptions: [{ filterId: PauseOnExceptionsState.All, condition: '(' }],
    });
    expect(stubDap.output.args).to.containSubset([[{ category: 'stderr' }]]);
    expect(stubCdp.Debugger.setPauseOnExceptions.called).to.be.false;
  });

  it('does not pause if script skipped', async () => {
    await ep.apply(stubCdp.actual);
    await ep.setBreakpoints({ filters: [PauseOnExceptionsState.All] });

    expect(
      await ep.shouldPauseAt({
        callFrames: [],
        reason: 'exception',
      }),
    ).to.be.true;

    isScriptSkipped.returns(true);

    expect(
      await ep.shouldPauseAt({
        callFrames: [],
        reason: 'exception',
      }),
    ).to.be.true;

    isScriptSkipped.returns(false);
  });
  it('prepares an expression if a condition is given', async () => {
    const expr = stub();
    prepareEval.returns({ invoke: expr });

    await ep.apply(stubCdp.actual);
    await ep.setBreakpoints({
      filters: [],
      filterOptions: [{ filterId: PauseOnExceptionsState.All, condition: 'error.name == "hi"' }],
    });
    expect(prepareEval.args[0]).to.deep.equal(['!!(error.name == "hi")', { hoist: ['error'] }]);
    expect(stubDap.output.called).to.be.false;
    expect(stubCdp.Debugger.setPauseOnExceptions.calledWith({ state: 'all' })).to.be.true;

    expr
      .onFirstCall()
      .resolves({ result: { value: true } })
      .onSecondCall()
      .resolves({ result: { value: false } });

    expect(
      await ep.shouldPauseAt({
        callFrames: [upcastPartial<Cdp.Debugger.CallFrame>({ callFrameId: '1' })],
        reason: 'exception',
        data: 'oh no!',
      }),
    ).to.be.true;

    expect(
      await ep.shouldPauseAt({
        callFrames: [upcastPartial<Cdp.Debugger.CallFrame>({ callFrameId: '1' })],
        reason: 'exception',
        data: 'oh no!',
      }),
    ).to.be.false;
  });
});
