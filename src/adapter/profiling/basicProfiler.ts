/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { IProfiler, StartProfileParams, IProfile } from '.';
import * as nls from 'vscode-nls';
import { injectable, inject } from 'inversify';
import Cdp from '../../cdp/api';
import { ICdpApi } from '../../cdp/connection';
import { EventEmitter } from '../../common/events';
import { ProtocolError, profileCaptureError } from '../../dap/errors';
import { FS, FsPromises } from '../../ioc-extras';

const localize = nls.loadMessageBundle();

export interface IBasicProfileParams {
  precise: boolean;
}

/**
 * Basic profiler that uses the stable CPU `Profiler` API available everywhere.
 * In Chrome, and probably in Node, this will be superceded by the Tracing API.
 */
@injectable()
export class BasicCpuProfiler implements IProfiler<IBasicProfileParams> {
  public static readonly type = 'cpu';
  public static readonly extension = '.cpuprofile';
  public static readonly label = localize('profile.cpu.label', 'CPU Profile');
  public static readonly description = localize(
    'profile.cpu.description',
    'Generates a .cpuprofile file you can open in the Chrome devtools',
  );

  public static canApplyTo() {
    return true; // this API is stable in all targets
  }

  constructor(
    @inject(ICdpApi) private readonly cdp: Cdp.Api,
    @inject(FS) private readonly fs: FsPromises,
  ) {}

  /**
   * @inheritdoc
   */
  public async start(options: StartProfileParams<IBasicProfileParams>) {
    await this.cdp.Profiler.enable({});

    if (!(await this.cdp.Profiler.start({}))) {
      throw new ProtocolError(profileCaptureError());
    }

    return new BasicProfile(this.cdp, this.fs, options);
  }
}

class BasicProfile implements IProfile {
  private readonly stopEmitter = new EventEmitter<void>();
  private disposed = false;

  /**
   * @inheritdoc
   */
  public readonly onUpdate = new EventEmitter<string>().event;

  /**
   * @inheritdoc
   */
  public readonly onStop = this.stopEmitter.event;

  constructor(
    private readonly cdp: Cdp.Api,
    private readonly fs: FsPromises,
    private readonly options: StartProfileParams<IBasicProfileParams>,
  ) {}

  /**
   * @inheritdoc
   */
  public async dispose() {
    if (!this.disposed) {
      this.disposed = true;
      await this.cdp.Profiler.disable({});
      this.stopEmitter.fire();
    }
  }

  /**
   * @inheritdoc
   */
  public async stop() {
    const result = await this.cdp.Profiler.stop({});
    if (!result) {
      throw new ProtocolError(profileCaptureError());
    }

    await this.dispose();
    await this.fs.writeFile(this.options.file, JSON.stringify(result.profile));
  }
}
