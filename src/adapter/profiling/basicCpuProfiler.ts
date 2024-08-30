/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import { inject, injectable } from 'inversify';
import { isAbsolute, join } from 'path';
import Cdp from '../../cdp/api';
import { ICdpApi } from '../../cdp/connection';
import { EventEmitter } from '../../common/events';
import { AnyLaunchConfiguration } from '../../configuration';
import { profileCaptureError } from '../../dap/errors';
import { ProtocolError } from '../../dap/protocolError';
import { FS, FsPromises } from '../../ioc-extras';
import { SourceContainer } from '../sourceContainer';
import { IProfile, IProfiler, StartProfileParams } from '.';
import { SourceAnnotationHelper } from './sourceAnnotationHelper';

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
  public static readonly label = l10n.t('CPU Profile');
  public static readonly description = l10n.t(
    'Generates a .cpuprofile file you can open in VS Code or the Edge/Chrome devtools',
  );
  public static readonly editable = true;

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
  public async start(_options: StartProfileParams<IBasicProfileParams>, file: string) {
    if (!(await this.cdp.Profiler.start({}))) {
      throw new ProtocolError(profileCaptureError());
    }

    return new BasicProfile(
      this.cdp,
      this.fs,
      this.sources,
      this.launchConfig.__workspaceFolder,
      file,
    );
  }

  /**
   * Annotates and saves the profile to the file path. If the file path is
   * not absolute, then it will be saved in the workspace folder.
   */
  public async save(profile: Cdp.Profiler.Profile, file: string) {
    const annotated = await annotateSources(
      profile,
      this.sources,
      this.launchConfig.__workspaceFolder,
    );
    if (!isAbsolute(file)) {
      file = join(this.launchConfig.__workspaceFolder, file);
    }

    await this.fs.writeFile(file, JSON.stringify(annotated));
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
    private readonly workspaceFolder: string,
    private readonly file: string,
  ) {}

  /**
   * @inheritdoc
   */
  public async dispose() {
    if (!this.disposed) {
      this.disposed = true;
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

    const annotated = await annotateSources(result.profile, this.sources, this.workspaceFolder);
    await this.fs.writeFile(this.file, JSON.stringify(annotated));
  }
}

/**
 * Adds source locations
 */
async function annotateSources(
  profile: Cdp.Profiler.Profile,
  sources: SourceContainer,
  workspaceFolder: string,
) {
  const helper = new SourceAnnotationHelper(sources);
  const nodes = profile.nodes.map(node => ({
    ...node,
    locationId: helper.getLocationIdFor(node.callFrame),
    positionTicks: node.positionTicks?.map(tick => ({
      ...tick,
      // weirdly, line numbers here are 1-based, not 0-based. The position tick
      // only gives line-level granularity, so 'mark' the entire range of source
      // code the tick refers to
      startLocationId: helper.getLocationIdFor({
        ...node.callFrame,
        lineNumber: tick.line - 1,
        columnNumber: 0,
      }),
      endLocationId: helper.getLocationIdFor({
        ...node.callFrame,
        lineNumber: tick.line,
        columnNumber: 0,
      }),
    })),
  }));

  return {
    ...profile,
    nodes,
    $vscode: {
      rootPath: workspaceFolder,
      locations: await helper.getLocations(),
    },
  };
}
