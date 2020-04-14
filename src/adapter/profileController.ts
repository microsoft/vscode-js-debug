/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { injectable, inject } from 'inversify';
import Cdp from '../cdp/api';
import { ICdpApi } from '../cdp/connection';
import Dap from '../dap/api';
import { IProfilerFactory, IProfile } from './profiling';
import { ProtocolError, invalidConcurrentProfile } from '../dap/errors';

/**
 * Provides profiling functionality for the debug adapter.
 */
export interface IProfileController {
  connect(dap: Dap.Api): void;
}

export const IProfileController = Symbol('IProfileController');

@injectable()
export class ProfileController implements IProfileController {
  private profile?: Promise<IProfile>;

  constructor(
    @inject(ICdpApi) private readonly cdp: Cdp.Api,
    @inject(IProfilerFactory) private readonly factory: IProfilerFactory,
  ) {}

  connect(dap: Dap.Api) {
    dap.on('startProfile', async params => {
      if (this.profile) {
        throw new ProtocolError(invalidConcurrentProfile());
      }

      this.profile = this.startProfile(dap, params).catch(err => {
        this.profile = undefined;
        throw err;
      });

      await this.profile;
      return {};
    });

    dap.on('stopProfile', async () => {
      const profile = await this.profile?.catch(() => undefined);
      await profile?.stop();
      dap.profilerStateUpdate({ label: '', running: false });
      this.profile = undefined;
      return {};
    });
  }

  private async startProfile(dap: Dap.Api, params: Dap.StartProfileParams) {
    await this.cdp.Debugger.disable({});
    const profile = await this.factory.get(params.type).start(params);
    profile.onUpdate(label => dap.profilerStateUpdate({ label, running: true }));
    profile.onStop(() => this.stopProfile(profile));
    return profile;
  }

  private async stopProfile(profile: IProfile) {
    await this.cdp.Debugger.enable({});
    profile.dispose();
  }
}
