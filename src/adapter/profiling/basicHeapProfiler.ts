/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { inject, injectable } from 'inversify';
import * as nls from 'vscode-nls';
import { IProfile, IProfiler, StartProfileParams } from '.';
import Cdp from '../../cdp/api';
import { ICdpApi } from '../../cdp/connection';
import { EventEmitter } from '../../common/events';
import { AnyLaunchConfiguration } from '../../configuration';
import Dap from '../../dap/api';
import { profileCaptureError } from '../../dap/errors';
import { ProtocolError } from '../../dap/protocolError';
import { FS, FsPromises } from '../../ioc-extras';
import { SourceContainer } from '../sources';

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
 * Basic profiler that uses the stable `HeapProfiler` API available everywhere.
 * In Chrome, and probably in Node, this will be superceded by the Tracing API.
 */
@injectable()
export class BasicHeapProfiler implements IProfiler<IBasicProfileParams> {
  public static readonly type = 'heap';
  public static readonly extension = '.heapprofile';
  public static readonly label = localize('profile.heap.label', 'Heap Profile');
  public static readonly description = localize(
    'profile.heap.description',
    'Generates a .heapprofile file you can open in the Chrome devtools',
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
    await this.cdp.HeapProfiler.enable({});

    if (!(await this.cdp.HeapProfiler.startSampling({}))) {
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
      await this.cdp.HeapProfiler.disable({});
      this.stopEmitter.fire();
    }
  }

  /**
   * @inheritdoc
   */
  public async stop() {
    const result = await this.cdp.HeapProfiler.stopSampling({});
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
  private async annotateSources(profile: Cdp.HeapProfiler.SamplingHeapProfile) {
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

    let nodes = [profile.head];

    while (nodes.length) {
      const node = nodes.pop();

      if (node) {
        const { callFrame } = node;
        (
          node as unknown as Cdp.HeapProfiler.SamplingHeapProfile & { locationId: number }
        ).locationId = getLocationIdFor(callFrame);

        nodes = nodes.concat(node.children);
      }
    }

    return {
      ...profile,
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
