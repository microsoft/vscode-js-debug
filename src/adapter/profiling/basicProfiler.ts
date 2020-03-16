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
import { SourceContainer } from '../sources';
import { AnyLaunchConfiguration } from '../../configuration';

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
    @inject(SourceContainer) private readonly sources: SourceContainer,
    @inject(AnyLaunchConfiguration) private readonly launchConfig: AnyLaunchConfiguration,
  ) {}

  /**
   * @inheritdoc
   */
  public async start(options: StartProfileParams<IBasicProfileParams>) {
    await this.cdp.Profiler.enable({});

    if (!(await this.cdp.Profiler.start({}))) {
      throw new ProtocolError(profileCaptureError());
    }

    return new BasicProfile(
      this.cdp,
      this.fs,
      this.sources,
      options,
      this.launchConfig.__workspaceFolder,
    );
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
    private readonly sources: SourceContainer,
    private readonly options: StartProfileParams<IBasicProfileParams>,
    private readonly workspaceFolder: string,
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

    const annotated = await this.annotateSources(result.profile);
    await this.fs.writeFile(this.options.file, JSON.stringify(annotated));
  }

  /**
   * Adds source locations
   */
  private async annotateSources(profile: Cdp.Profiler.Profile) {
    return {
      $vscode: {
        rootPath: this.workspaceFolder,
        locations: await Promise.all(
          profile.nodes.map(async node => {
            const source = await this.sources.scriptsById.get(node.callFrame.scriptId)?.source;
            if (!source) {
              return;
            }

            const locations = this.sources.currentSiblingUiLocations({
              lineNumber: node.callFrame.lineNumber + 1,
              columnNumber: node.callFrame.columnNumber + 1,
              source,
            });

            return Promise.all(
              locations.map(async loc => ({ ...loc, source: await loc.source.toDap() })),
            );
          }),
        ),
      },
      ...profile,
    };
  }
}
