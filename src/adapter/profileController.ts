/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import { randomBytes } from 'crypto';
import { inject, injectable } from 'inversify';
import { tmpdir } from 'os';
import { join } from 'path';
import Cdp from '../cdp/api';
import { ICdpApi } from '../cdp/connection';
import Dap from '../dap/api';
import { invalidConcurrentProfile } from '../dap/errors';
import { ProtocolError } from '../dap/protocolError';
import { IShutdownParticipants, ShutdownOrder } from '../ui/shutdownParticipants';
import { BreakpointEnableFilter, BreakpointManager } from './breakpoints';
import { UserDefinedBreakpoint } from './breakpoints/userDefinedBreakpoint';
import { getDefaultProfileName, IProfile, IProfilerFactory } from './profiling';
import { BasicCpuProfiler } from './profiling/basicCpuProfiler';
import { Thread } from './threads';

/**
 * Provides profiling functionality for the debug adapter.
 */
export interface IProfileController {
  connect(dap: Dap.Api, thread: Thread): void;
  start(dap: Dap.Api, thread: Thread, params: Dap.StartProfileParams): Promise<void>;
}

export const IProfileController = Symbol('IProfileController');

interface IRunningProfile {
  file: string;
  profile: IProfile;
  keptDebuggerOn: boolean;
  enableFilter: BreakpointEnableFilter;
}

@injectable()
export class ProfileController implements IProfileController {
  private profile?: Promise<IRunningProfile>;
  private seenConsoleProfileNames = Object.create(null);

  constructor(
    @inject(ICdpApi) private readonly cdp: Cdp.Api,
    @inject(IProfilerFactory) private readonly factory: IProfilerFactory,
    @inject(BasicCpuProfiler) private readonly basicCpuProfiler: BasicCpuProfiler,
    @inject(BreakpointManager) private readonly breakpoints: BreakpointManager,
    @inject(IShutdownParticipants) private readonly shutdown: IShutdownParticipants,
  ) {}

  /**
   * @inheritdoc
   */
  connect(dap: Dap.Api, thread: Thread) {
    dap.on('startProfile', async params => {
      await this.start(dap, thread, params);
      return {};
    });

    dap.on('stopProfile', () => this.stopProfiling(dap));

    this.cdp.Profiler.on('consoleProfileStarted', () => {
      dap.output({
        output: l10n.t('Console profile started') + '\n',
        category: 'console',
      });
    });

    this.cdp.Profiler.on('consoleProfileFinished', async evt => {
      const promise = this.saveConsoleProfile(dap, evt);
      const shutdownBlocker = this.shutdown.register(
        ShutdownOrder.ExecutionContexts,
        () => promise,
      );
      await promise;
      shutdownBlocker.dispose();
    });

    thread.onPaused(() => this.stopProfiling(dap));
  }

  /**
   * @inheritdoc
   */
  public async start(dap: Dap.Api, thread: Thread, params: Dap.StartProfileParams): Promise<void> {
    if (this.profile) {
      throw new ProtocolError(invalidConcurrentProfile());
    }

    this.profile = this.startProfileInner(dap, thread, params).catch(err => {
      this.profile = undefined;
      throw err;
    });

    await this.profile;
  }

  private async saveConsoleProfile(dap: Dap.Api, evt: Cdp.Profiler.ConsoleProfileFinishedEvent) {
    let basename: string;
    if (evt.title) {
      basename = evt.title.replace(/[\/\\]/g, '-');
      const nth = this.seenConsoleProfileNames[evt.title] || 0;
      this.seenConsoleProfileNames[evt.title] = nth + 1;
      if (nth > 0) {
        basename += `-${nth}`;
      }
    } else {
      basename = getDefaultProfileName();
    }

    basename += BasicCpuProfiler.extension;
    await this.basicCpuProfiler.save(evt.profile, basename);

    dap.output({
      output: l10n.t('CPU profile saved as "{0}" in your workspace folder', basename) + '\n',
      category: 'console',
    });
  }

  private async startProfileInner(dap: Dap.Api, thread: Thread, params: Dap.StartProfileParams) {
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

    const file = join(tmpdir(), `vscode-js-profile-${randomBytes(4).toString('hex')}`);
    const profile = await this.factory.get(params.type).start(params, file);
    const runningProfile: IRunningProfile = {
      file,
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

    dap.profileStarted({ file: runningProfile.file, type: params.type });
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
