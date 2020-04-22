/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { Logger } from '../../../common/logging/logger';
import { LogLevel } from '../../../common/logging';

const logger = new Logger();
logger.setup({
  level: LogLevel.Info,
  sinks: [
    //new FileLogSink(require('path').join(require('os').homedir(), 'bootloader.txt'))
  ],
});

export const bootloaderLogger = logger;
