/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import { createWriteStream, WriteStream } from 'fs';
import { inject, injectable } from 'inversify';
import Cdp from '../../cdp/api';
import { ICdpApi } from '../../cdp/connection';
import { EventEmitter } from '../../common/events';
import { IProfile, IProfiler, StartProfileParams } from '.';

/**
 * Basic instant that uses the HeapProfiler API to grab a snapshot.
 */
@injectable()
export class HeapDumpProfiler implements IProfiler<void> {
  public static readonly type = 'memory';
  public static readonly extension = '.heapsnapshot';
  public static readonly label = l10n.t('Heap Snapshot');
  public static readonly description = l10n.t(
    'Generates a .heapsnapshot file you can open in VS Code or the Edge/Chrome devtools',
  );
  public static readonly instant = true;

  public static canApplyTo() {
    return true; // this API is stable in all targets
  }

  private currentWriter?: {
    stream: WriteStream;
    promise: Promise<unknown>;
  };

  constructor(@inject(ICdpApi) private readonly cdp: Cdp.Api) {
    this.cdp.HeapProfiler.on(
      'addHeapSnapshotChunk',
      ({ chunk }) => this.currentWriter?.stream.write(chunk),
    );
  }

  /**
   * @inheritdoc
   */
  public async start(_options: StartProfileParams<void>, file: string): Promise<IProfile> {
    return {
      onStop: new EventEmitter<void>().event,
      onUpdate: new EventEmitter<string>().event,
      dispose: () => undefined,
      stop: async () => {
        await this.cdp.HeapProfiler.enable({});
        await this.dumpToFile(file);
        await this.cdp.HeapProfiler.disable({});
      },
    };
  }

  private async dumpToFile(filename: string) {
    const { stream, promise } = (this.currentWriter = {
      stream: createWriteStream(filename),
      promise: this.cdp.HeapProfiler.takeHeapSnapshot({}),
    });

    await promise;
    stream.end();
    this.currentWriter = undefined;
  }
}
