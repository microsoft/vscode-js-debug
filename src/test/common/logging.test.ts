/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { expect } from 'chai';
import { stub, SinonStub } from 'sinon';
import { Logger } from '../../common/logging/logger';
import { LogTag, LogLevel } from '../../common/logging';

describe('Logger', () => {
  let sink: { write: SinonStub; setup: SinonStub; dispose: SinonStub };
  let logger: Logger;

  beforeEach(() => {
    sink = { write: stub(), setup: stub().resolves(), dispose: stub() };
    logger = new Logger();
  });

  it('buffers and logs messages once sinks are attached', async () => {
    logger.verbose(LogTag.Runtime, 'Hello world!');
    await logger.setup({ level: LogLevel.Verbose, sinks: [sink], showWelcome: false });
    expect(sink.write.args[0][0]).to.containSubset({
      tag: LogTag.Runtime,
      message: 'Hello world!',
      level: LogLevel.Verbose,
    });
  });

  it('applies level filters before and after attach', async () => {
    logger.verbose(LogTag.Runtime, 'a');
    logger.warn(LogTag.Runtime, 'b');
    await logger.setup({ level: LogLevel.Warn, sinks: [sink], showWelcome: false });
    logger.verbose(LogTag.Runtime, 'c');
    logger.warn(LogTag.Runtime, 'd');
    expect(sink.write.args.map(a => a[0].message)).to.deep.equal(['b', 'd']);
  });

  it('applies tag filters before and after attach', async () => {
    logger.verbose(LogTag.DapSend, 'a');
    logger.warn(LogTag.Runtime, 'b');
    logger.warn(LogTag.RuntimeException, 'c');
    await logger.setup({
      level: LogLevel.Verbose,
      tags: [LogTag.Runtime],
      sinks: [sink],
      showWelcome: false,
    });
    logger.verbose(LogTag.DapSend, 'd');
    logger.warn(LogTag.Runtime, 'e');
    logger.warn(LogTag.RuntimeException, 'f');
    expect(sink.write.args.map(a => a[0].message)).to.deep.equal(['b', 'c', 'e', 'f']);
  });
});
