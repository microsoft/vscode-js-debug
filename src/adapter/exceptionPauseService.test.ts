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
import { SourceContainer } from './sourceContainer';

describe('ExceptionPauseService', () => {
  let prepareEval: SinonStub;
  let isScriptSkipped: SinonStub;
  let ep: ExceptionPauseService;
  let stubDap: StubDapApi;
  let stubCdp: StubCdpApi;
  let getScriptById: SinonStub;

  beforeEach(() => {
    prepareEval = stub();
    isScriptSkipped = stub().returns(false);
    stubDap = stubbedDapApi();
    stubCdp = stubbedCdpApi();
    getScriptById = stub();
    ep = new ExceptionPauseService(
      upcastPartial<IEvaluator>({ prepare: prepareEval }),
      upcastPartial<ScriptSkipper>({ isScriptSkipped }),
      stubDap as unknown as Dap.Api,
      upcastPartial<AnyLaunchConfiguration>({}),
      upcastPartial<SourceContainer>({ getScriptById, getSourceScriptById: getScriptById }),
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
    getScriptById.withArgs('42').returns({ url: 'file:///skipped' });
    getScriptById.withArgs('43').returns({ url: 'file:///not-skipped' });
    isScriptSkipped.withArgs('file:///skipped').returns(true);
    isScriptSkipped.withArgs('file:///not-skipped').returns(false);

    expect(
      await ep.shouldPauseAt({
        callFrames: [{ location: { scriptId: '42' } } as unknown as Cdp.Debugger.CallFrame],
        reason: 'exception',
      }),
    ).to.be.false;

    expect(
      await ep.shouldPauseAt({
        callFrames: [{ location: { scriptId: '43' } } as unknown as Cdp.Debugger.CallFrame],
        reason: 'exception',
      }),
    ).to.be.true;
  });
  it('prepares an expression if a condition is given', async () => {
    const expr = stub();
    prepareEval.returns({ invoke: expr });

    await ep.apply(stubCdp.actual);
    await ep.setBreakpoints({
      filters: [],
      filterOptions: [{ filterId: PauseOnExceptionsState.All, condition: 'error.name == "hi"' }],
    });
    expect(prepareEval.args[0]).to.deep.equal([
      '(()=>{try{return !!(error.name == "hi");}catch(e){console.error(`Breakpoint condition error: ${e.message||e}`);return false}})()',
      { hoist: ['error'] },
    ]);
    expect(stubDap.output.called).to.be.false;
    expect(stubCdp.Debugger.setPauseOnExceptions.calledWith({ state: 'all' })).to.be.true;

    expr
      .onFirstCall()
      .resolves({ result: { value: true } })
      .onSecondCall()
      .resolves({ result: { value: false } });

    expect(
      await ep.shouldPauseAt({
        callFrames: [
          upcastPartial<Cdp.Debugger.CallFrame>({
            callFrameId: '1',
            location: upcastPartial<Cdp.Debugger.Location>({ scriptId: '42' }),
          }),
        ],
        reason: 'exception',
        data: 'oh no!',
      }),
    ).to.be.true;

    expect(
      await ep.shouldPauseAt({
        callFrames: [
          upcastPartial<Cdp.Debugger.CallFrame>({
            callFrameId: '1',
            location: upcastPartial<Cdp.Debugger.Location>({ scriptId: '42' }),
          }),
        ],
        reason: 'exception',
        data: 'oh no!',
      }),
    ).to.be.false;
  });
});
