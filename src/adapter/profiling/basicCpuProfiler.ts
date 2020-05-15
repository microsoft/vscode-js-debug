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
import Dap from '../../dap/api';

const localize = nls.loadMessageBundle();

export interface IBasicProfileParams {
  precise: boolean;
}

interface IEmbeddedLocation {
  lineNumber: number;
  columnNumber: number;
  source: Dap.Source;
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
  public async start(_options: StartProfileParams<IBasicProfileParams>, file: string) {
    await this.cdp.Profiler.enable({});

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
    await this.fs.writeFile(this.file, JSON.stringify(annotated));
  }

  /**
   * Adds source locations
   */
  private async annotateSources(profile: Cdp.Profiler.Profile) {
    let locationIdCounter = 0;
    const locationsByRef = new Map<
      string,
      { id: number; callFrame: Cdp.Runtime.CallFrame; locations: Promise<IEmbeddedLocation[]> }
    >();

    const getLocationIdFor = (callFrame: Cdp.Runtime.CallFrame) => {
      const ref = [
        callFrame.functionName,
        callFrame.url,
        callFrame.scriptId,
        callFrame.lineNumber,
        callFrame.columnNumber,
      ].join(':');

      const existing = locationsByRef.get(ref);
      if (existing) {
        return existing.id;
      }

      const id = locationIdCounter++;
      locationsByRef.set(ref, {
        id,
        callFrame,
        locations: (async () => {
          const source = await this.sources.scriptsById.get(callFrame.scriptId)?.source;
          if (!source) {
            return [];
          }

          return Promise.all(
            this.sources
              .currentSiblingUiLocations({
                lineNumber: callFrame.lineNumber + 1,
                columnNumber: callFrame.columnNumber + 1,
                source,
              })
              .map(async loc => ({ ...loc, source: await loc.source.toDapShallow() })),
          );
        })(),
      });

      return id;
    };

    const nodes = profile.nodes.map(node => ({
      ...node,
      locationId: getLocationIdFor(node.callFrame),
      positionTicks: node.positionTicks?.map(tick => ({
        ...tick,
        // weirdly, line numbers here are 1-based, not 0-based. The position tick
        // only gives line-level granularity, so 'mark' the entire range of source
        // code the tick refers to
        startLocationId: getLocationIdFor({
          ...node.callFrame,
          lineNumber: tick.line - 1,
          columnNumber: 0,
        }),
        endLocationId: getLocationIdFor({
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
        rootPath: this.workspaceFolder,
        locations: await Promise.all(
          [...locationsByRef.values()]
            .sort((a, b) => a.id - b.id)
            .map(async l => ({ callFrame: l.callFrame, locations: await l.locations })),
        ),
      },
    };
  }
}
