/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import { inject, injectable } from 'inversify';
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

/**
 * Basic profiler that uses the stable `HeapProfiler` API available everywhere.
 * In Chrome, and probably in Node, this will be superceded by the Tracing API.
 */
@injectable()
export class BasicHeapProfiler implements IProfiler<{}> {
  public static readonly type = 'heap';
  public static readonly extension = '.heapprofile';
  public static readonly label = l10n.t('Heap Profile');
  public static readonly description = l10n.t(
    'Generates a .heapprofile file you can open in VS Code or the Edge/Chrome devtools',
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
  public async start(_options: StartProfileParams<{}>, file: string) {
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
    const helper = new SourceAnnotationHelper(this.sources);

    const setLocationId = (
      node: Cdp.HeapProfiler.SamplingHeapProfileNode,
      destNode: Cdp.HeapProfiler.SamplingHeapProfileNode & {
        locationId?: number;
      },
    ) => {
      destNode.locationId = helper.getLocationIdFor(node.callFrame);

      for (const child of node.children) {
        const destChild = { ...child, children: [] };
        destNode.children.push(destChild);
        setLocationId(child, destChild);
      }
    };

    const head = {
      ...profile.head,
      children: [],
    };

    setLocationId(profile.head, head);

    return {
      ...profile,
      head,
      $vscode: {
        rootPath: this.workspaceFolder,
        locations: await helper.getLocations(),
      },
    };
  }
}
