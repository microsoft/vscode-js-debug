/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import 'reflect-metadata';

import { IWatchdogInfo, WatchDog } from './watchdogSpawn';
import { Logger } from '../../common/logging/logger';
import { LogLevel, LogTag } from '../../common/logging';
import { installUnhandledErrorReporter } from '../../telemetry/unhandledErrorReporter';
import { NullTelemetryReporter } from '../../telemetry/nullTelemetryReporter';

// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
const info: IWatchdogInfo = JSON.parse(process.env.NODE_INSPECTOR_INFO!);

const logger = new Logger();
logger.setup({
  level: LogLevel.Info,
  sinks: [
    /*new FileLogSink(require('path').join(require('os').homedir(), 'watchdog.txt'))*/
  ],
});

installUnhandledErrorReporter(logger, new NullTelemetryReporter());

process.on('exit', () => {
  logger.info(LogTag.Runtime, 'Process exiting');
  logger.dispose();

  if (info.pid && !info.dynamicAttach) {
    process.kill(Number(info.pid));
  }
});

(async () => {
  const wd = await WatchDog.attach(info);
  wd.onEnd(() => process.exit());
})();
