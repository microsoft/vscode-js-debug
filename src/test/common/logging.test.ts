/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { expect } from 'chai';
import { SinonStub, stub } from 'sinon';
import { LogLevel, LogTag } from '../../common/logging';
import { Logger } from '../../common/logging/logger';

describe('Logger', () => {
  let sink: { write: SinonStub; setup: SinonStub; dispose: SinonStub };
  let logger: Logger;

  beforeEach(() => {
    sink = { write: stub(), setup: stub().resolves(), dispose: stub() };
    logger = new Logger();
  });

  it('buffers and logs messages once sinks are attached', async () => {
    logger.verbose(LogTag.Runtime, 'Hello world!');
    await logger.setup({ sinks: [sink], showWelcome: false });
    expect(sink.write.args[0][0]).to.containSubset({
      tag: LogTag.Runtime,
      message: 'Hello world!',
      level: LogLevel.Verbose,
    });
  });
});
