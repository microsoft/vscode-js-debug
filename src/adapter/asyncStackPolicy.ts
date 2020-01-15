/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { IDisposable, noOpDisposable, DisposableList } from '../common/disposable';
import Cdp from '../cdp/api';
import { AsyncStackMode } from '../configuration';
import { EventEmitter } from '../common/events';

/**
 * Controls when async stack traces are enabled in the debugee, either
 * at start or only when we resolve a breakpoint.
 *
 * This is useful because requesting async stacktraces increases bookkeeping
 * that V8 needs to do and can cause significant slowdowns.
 */
export interface IAsyncStackPolicy {
  /**
   * Installs the policy on the given CDP API.
   */
  connect(cdp: Cdp.Api): Promise<IDisposable>;
}

const disabled: IAsyncStackPolicy = { connect: async () => noOpDisposable };

const eager = (maxDepth: number): IAsyncStackPolicy => ({
  async connect(cdp) {
    await cdp.Debugger.setAsyncCallStackDepth({ maxDepth });
    return noOpDisposable;
  },
});

const onceBp = (maxDepth: number): IAsyncStackPolicy => {
  const onEnable: EventEmitter<void> | undefined = new EventEmitter<void>();
  let enabled = false;
  const tryEnable = () => {
    if (!enabled) {
      enabled = true;
      onEnable.fire();
    }
  };

  return {
    async connect(cdp) {
      if (enabled) {
        await cdp.Debugger.setAsyncCallStackDepth({ maxDepth });
        return noOpDisposable;
      }

      const disposable = new DisposableList();

      disposable.push(
        // Another session enabled breakpoints. Turn this on as well, e.g. if
        // we have a parent page and webworkers, when we debug the webworkers
        // should also have their async stacks turned on.
        onEnable.event(() => {
          disposable.dispose();
          cdp.Debugger.setAsyncCallStackDepth({ maxDepth });
        }),
        // when a breakpoint resolves, turn on stacks because we're likely to
        // pause sooner or later
        cdp.Debugger.on('breakpointResolved', tryEnable),
        // start collecting on a pause event. This can be from source map
        // instrumentation, entrypoint breakpoints, debugger statements, or user
        // defined breakpoints. Instrumentation points happen all the time and
        // can be ignored. For others, including entrypoint breaks (which
        // indicate there's a user break somewhere in the file) we should turn on.
        cdp.Debugger.on('paused', evt => {
          if (evt.reason !== 'instrumentation') {
            tryEnable();
          }
        }),
      );

      return disposable;
    },
  };
};

const defaultPolicy = eager(32);

export const getAsyncStackPolicy = (mode: AsyncStackMode) => {
  if (mode === false) {
    return disabled;
  }

  if (mode === true) {
    return defaultPolicy;
  }

  if ('onAttach' in mode) {
    return eager(mode.onAttach);
  }

  if ('onceBreakpointResolved' in mode) {
    return onceBp(mode.onceBreakpointResolved);
  }

  return defaultPolicy;
};
