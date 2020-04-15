/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { injectable, inject } from 'inversify';
import Cdp from '../cdp/api';
import { ICdpApi } from '../cdp/connection';
import Dap from '../dap/api';
import { IProfilerFactory, IProfile } from './profiling';
import { ProtocolError, invalidConcurrentProfile } from '../dap/errors';
import { Thread } from './threads';
import { BreakpointManager, BreakpointEnableFilter } from './breakpoints';
import { UserDefinedBreakpoint } from './breakpoints/userDefinedBreakpoint';

/**
 * Provides profiling functionality for the debug adapter.
 */
export interface IProfileController {
  connect(dap: Dap.Api, thread: Thread): void;
}

export const IProfileController = Symbol('IProfileController');

interface IRunningProfile {
  profile: IProfile;
  keptDebuggerOn: boolean;
  enableFilter: BreakpointEnableFilter;
}

@injectable()
export class ProfileController implements IProfileController {
  private profile?: Promise<IRunningProfile>;

  constructor(
    @inject(ICdpApi) private readonly cdp: Cdp.Api,
    @inject(IProfilerFactory) private readonly factory: IProfilerFactory,
    @inject(BreakpointManager) private readonly breakpoints: BreakpointManager,
  ) {}

  /**
   * @inheritdoc
   */
  connect(dap: Dap.Api, thread: Thread) {
    dap.on('startProfile', async params => {
      if (this.profile) {
        throw new ProtocolError(invalidConcurrentProfile());
      }

      this.profile = this.startProfile(dap, thread, params).catch(err => {
        this.profile = undefined;
        throw err;
      });

      await this.profile;
      return {};
    });

    dap.on('stopProfile', () => this.stopProfiling(dap));
    thread.onPaused(() => this.stopProfiling(dap));
  }

  private async startProfile(dap: Dap.Api, thread: Thread, params: Dap.StartProfileParams) {
    let keepDebuggerOn = false;
    let enableFilter: BreakpointEnableFilter;
    if (params.stopAtBreakpoint?.length) {
      const toBreakpoint = new Set(params.stopAtBreakpoint);
      keepDebuggerOn = true;
      enableFilter = bp => !(bp instanceof UserDefinedBreakpoint) || toBreakpoint.has(bp.dapId);
    } else {
      enableFilter = () => false;
    }

    await this.breakpoints.applyEnabledFilter(enableFilter);

    const profile = await this.factory.get(params.type).start(params);
    const runningProfile: IRunningProfile = {
      profile,
      enableFilter,
      keptDebuggerOn: keepDebuggerOn,
    };

    profile.onUpdate(label => dap.profilerStateUpdate({ label, running: true }));
    profile.onStop(() => this.disposeProfile(runningProfile));

    const isPaused = !!thread.pausedDetails();

    if (keepDebuggerOn) {
      await thread.resume();
    } else if (isPaused) {
      await this.cdp.Debugger.disable({});
      if (isPaused) {
        thread.onResumed(); // see docs on this method for why we call it here
      }
    }

    return runningProfile;
  }

  private async stopProfiling(dap: Dap.Api) {
    const running = await this.profile?.catch(() => undefined);
    if (!running || !this.profile) {
      return {}; // guard against concurrent stops
    }

    this.profile = undefined;
    await running?.profile.stop();
    dap.profilerStateUpdate({ label: '', running: false });
    return {};
  }

  private async disposeProfile({ profile, enableFilter, keptDebuggerOn }: IRunningProfile) {
    if (!keptDebuggerOn) {
      await this.cdp.Debugger.enable({});
    }

    await this.breakpoints.applyEnabledFilter(undefined, enableFilter);
    profile.dispose();
  }
}
