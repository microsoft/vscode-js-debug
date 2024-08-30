/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { inject, injectable } from 'inversify';
import Cdp from '../cdp/api';
import { truthy } from '../common/objUtils';
import { getDeferred } from '../common/promiseUtil';
import { getSyntaxErrorIn, SourceConstants } from '../common/sourceUtils';
import { AnyLaunchConfiguration } from '../configuration';
import Dap from '../dap/api';
import { IDapApi } from '../dap/connection';
import { invalidBreakPointCondition } from '../dap/errors';
import { ProtocolError } from '../dap/protocolError';
import { wrapBreakCondition } from './breakpoints/conditions/expression';
import { IEvaluator, PreparedCallFrameExpr } from './evaluator';
import { IScriptSkipper } from './scriptSkipper/scriptSkipper';
import { SourceContainer } from './sourceContainer';

export interface IExceptionPauseService {
  readonly launchBlocker: Promise<void>;

  /**
   * Updates the breakpoint pause state in the service.
   */
  setBreakpoints(params: Dap.SetExceptionBreakpointsParams): Promise<void>;

  /**
   * Gets whether the exception pause service would like the debugger to
   * remain paused at the given point. Will return false if the event is
   * not an exception pause.
   */
  shouldPauseAt(evt: Cdp.Debugger.PausedEvent): Promise<boolean>;

  /**
   * Applies the exception pause service to the CDP connection. This should
   * be called only after the Debugger domain has been enabled.
   */
  apply(cdp: Cdp.Api): Promise<void>;
}

export const IExceptionPauseService = Symbol('IExceptionPauseService');

export const enum PauseOnExceptionsState {
  None = 'none',
  All = 'all',
  Uncaught = 'uncaught',
}

type ActivePause = {
  cdp: PauseOnExceptionsState.All | PauseOnExceptionsState.Uncaught;
  condition: { caught?: PreparedCallFrameExpr; uncaught?: PreparedCallFrameExpr };
};

/**
 * Internal representation of set exception breakpoints. For conditional
 * exception breakpoints, we instruct CDP to pause on all exceptions, but
 * then run expressions and check their truthiness to figure out if we
 * should actually stop.
 */
type PauseOnExceptions = { cdp: PauseOnExceptionsState.None } | ActivePause;

@injectable()
export class ExceptionPauseService implements IExceptionPauseService {
  private state: PauseOnExceptions = { cdp: PauseOnExceptionsState.None };
  private cdp?: Cdp.Api;
  private breakOnError: boolean;
  private noDebug: boolean;
  private blocker = getDeferred<void>();

  public get launchBlocker() {
    return this.blocker.promise;
  }

  constructor(
    @inject(IEvaluator) private readonly evaluator: IEvaluator,
    @inject(IScriptSkipper) private readonly scriptSkipper: IScriptSkipper,
    @inject(IDapApi) private readonly dap: Dap.Api,
    @inject(AnyLaunchConfiguration) launchConfig: AnyLaunchConfiguration,
    @inject(SourceContainer) private readonly sourceContainer: SourceContainer,
  ) {
    this.noDebug = !!launchConfig.noDebug;
    this.breakOnError = launchConfig.__breakOnConditionalError;
    this.blocker.resolve();
  }

  /**
   * @inheritdoc
   */
  public async setBreakpoints(params: Dap.SetExceptionBreakpointsParams) {
    if (this.noDebug) {
      return;
    }

    try {
      this.state = this.parseBreakpointRequest(params);
    } catch (e) {
      if (!(e instanceof ProtocolError)) {
        throw e;
      }
      this.dap.output({ category: 'stderr', output: e.message });
      return;
    }

    if (this.cdp) {
      await this.sendToCdp(this.cdp);
    } else if (this.state.cdp !== PauseOnExceptionsState.None && this.blocker.hasSettled()) {
      this.blocker = getDeferred();
    }
  }

  /**
   * @inheritdoc
   */
  public async shouldPauseAt(evt: Cdp.Debugger.PausedEvent) {
    if (
      (evt.reason !== 'exception' && evt.reason !== 'promiseRejection')
      || this.state.cdp === PauseOnExceptionsState.None
    ) {
      return false;
    }

    // If there's an internal frame anywhere in the stack, this call is from
    // some internally-executed script not visible for the user. Never pause
    // if this results in an exception: the caller should handle it.
    if (
      evt.callFrames.some(cf =>
        this.sourceContainer
          .getSourceScriptById(cf.location.scriptId)
          ?.url.endsWith(SourceConstants.InternalExtension)
      )
    ) {
      return false;
    }

    if (this.shouldScriptSkip(evt)) {
      return false;
    }

    const cond = this.state.condition;
    if (evt.data?.uncaught) {
      if (cond.uncaught && !(await this.evalCondition(evt, cond.uncaught))) {
        return false;
      }
    } else if (cond.caught) {
      if (!(await this.evalCondition(evt, cond.caught))) {
        return false;
      }
    }

    return true;
  }

  /**
   * @inheritdoc
   */
  public async apply(cdp: Cdp.Api) {
    this.cdp = cdp;

    if (this.state.cdp !== PauseOnExceptionsState.None) {
      await this.sendToCdp(cdp);
    }
  }

  private async sendToCdp(cdp: Cdp.Api) {
    await cdp.Debugger.setPauseOnExceptions({ state: this.state.cdp });
    this.blocker.resolve();
  }

  private async evalCondition(evt: Cdp.Debugger.PausedEvent, method: PreparedCallFrameExpr) {
    const r = await method(
      { callFrameId: evt.callFrames[0].callFrameId },
      v => v === 'error' ? evt.data : undefined,
    );
    return !!r?.result.value;
  }

  /**
   * Setting blackbox patterns is asynchronous to when the source is loaded,
   * so if the user asks to pause on exceptions the runtime may pause in a
   * place where we don't want it to. Double check at this point and manually
   * resume debugging for handled exceptions. This implementation seems to
   * work identically to blackboxing (test cases represent this):
   *
   * - ✅ An error is thrown and caught within skipFiles. Resumed here.
   * - ✅ An uncaught error is re/thrown within skipFiles. In both cases the
   *      stack is reported at the first non-skipped file is shown.
   * - ✅ An error is thrown from skipFiles and caught in user code. In both
   *      blackboxing and this version, the debugger will not pause.
   * - ✅ An error is thrown anywhere in user code. All good.
   *
   * See: https://github.com/microsoft/vscode-js-debug/issues/644
   */
  private shouldScriptSkip(evt: Cdp.Debugger.PausedEvent) {
    if (evt.data?.uncaught || !evt.callFrames.length) {
      return false;
    }

    const script = this.sourceContainer.getScriptById(evt.callFrames[0].location.scriptId);
    return !!script && this.scriptSkipper.isScriptSkipped(script.url);
  }

  /**
   * Parses the breakpoint request into the "PauseOnException" type for easier
   * handling internally.
   */
  protected parseBreakpointRequest(params: Dap.SetExceptionBreakpointsParams): PauseOnExceptions {
    const filters = (params.filterOptions ?? []).concat(
      params.filters.map(filterId => ({ filterId })),
    );

    let cdp = PauseOnExceptionsState.None;
    const caughtConditions: string[] = [];
    const uncaughtConditions: string[] = [];

    for (const { filterId, condition } of filters) {
      if (filterId === PauseOnExceptionsState.All) {
        cdp = PauseOnExceptionsState.All;
        if (condition) {
          caughtConditions.push(filterId);
        }
      } else if (filterId === PauseOnExceptionsState.Uncaught) {
        if (cdp === PauseOnExceptionsState.None) {
          cdp = PauseOnExceptionsState.Uncaught;
        }
        if (condition) {
          uncaughtConditions.push(filterId);
        }
      }
    }

    const compile = (condition: string[]) => {
      if (condition.length === 0) {
        return undefined;
      }

      const expr = '!!('
        + filters
          .map(f => f.condition)
          .filter(truthy)
          .join(') || !!(')
        + ')';

      const err = getSyntaxErrorIn(expr);
      if (err) {
        throw new ProtocolError(
          invalidBreakPointCondition({ line: 0, condition: expr }, err.message),
        );
      }

      const wrapped = wrapBreakCondition(expr, this.breakOnError);
      return this.evaluator.prepare(wrapped, { hoist: ['error'] }).invoke;
    };

    if (cdp === PauseOnExceptionsState.None) {
      return { cdp };
    } else {
      return {
        cdp,
        condition: { caught: compile(caughtConditions), uncaught: compile(uncaughtConditions) },
      };
    }
  }
}
