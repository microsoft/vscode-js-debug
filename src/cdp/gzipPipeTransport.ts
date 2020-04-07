/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { ILogger } from '../common/logging';
import { Duplex, Readable, Writable } from 'stream';
import { RawPipeTransport } from './rawPipeTransport';
import { createGzip, createGunzip, Gzip, constants } from 'zlib';

export class GzipPipeTransport extends RawPipeTransport {
  constructor(logger: ILogger, socket: Duplex);
  constructor(logger: ILogger, pipeWrite: Writable, pipeRead: Readable);
  constructor(logger: ILogger, write: Duplex | Writable, pipeRead?: Readable) {
    super(logger, createGzip(), (pipeRead || write).pipe(createGunzip()));
    this.pipeWrite.pipe(write);
  }

  /**
   * @override
   */
  public send(message: string) {
    super.send(message);
    (this.pipeWrite as Gzip).flush(constants.Z_SYNC_FLUSH);
  }

  /**
   * @override
   */
  protected beforeClose() {
    (this.pipeWrite as Gzip).flush(constants.Z_FINISH);
  }
}
