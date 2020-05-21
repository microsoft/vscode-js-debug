/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import 'reflect-metadata';

import * as net from 'net';
import { IWatchdogInfo } from './watchdogSpawn';
import { NeverCancelled } from '../../common/cancellation';
import { Logger } from '../../common/logging/logger';
import { LogLevel, LogTag } from '../../common/logging';
import { installUnhandledErrorReporter } from '../../telemetry/unhandledErrorReporter';
import { NullTelemetryReporter } from '../../telemetry/nullTelemetryReporter';
import { RawPipeTransport } from '../../cdp/rawPipeTransport';
import { WebSocketTransport } from '../../cdp/webSocketTransport';

// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
const info: IWatchdogInfo = JSON.parse(process.env.NODE_INSPECTOR_INFO!);

(async () => {
  WatchD
});
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
  logger.info(LogTag.Runtime, 'Connected to target');
  const pipe: net.Socket = await new Promise(resolve => {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const cnx: net.Socket = net.createConnection(process.env.NODE_INSPECTOR_IPC!, () =>
      resolve(cnx),
    );
  });

  const server = new RawPipeTransport(Logger.null, pipe);

  const targetInfo = {
    targetId: info.pid || '0',
    type: info.waitForDebugger ? 'waitingForDebugger' : '',
    title: info.scriptName,
    url: 'file://' + info.scriptName,
    openerId: info.ppid,
  };

  server.send(JSON.stringify({ method: 'Target.targetCreated', params: { targetInfo } }));
  logger.info(LogTag.Runtime, 'Connected to server');

  let target: WebSocketTransport | undefined;

  server.onMessage(async ([data]) => {
    // Fast-path to check if we might need to parse it:
    if (
      target &&
      !data.includes('Target.attachToTarget') &&
      !data.includes('Target.detachFromTarget')
    ) {
      target.send(data);
      return;
    }

    let result: unknown = {};
    const object = JSON.parse(data);

    if (object.method === 'Target.attachToTarget') {
      logger.info(LogTag.Runtime, 'Attached to target', object);
      if (target) {
        target.dispose();
        target = undefined;
      }
      target = await WebSocketTransport.create(info.inspectorURL, NeverCancelled);
      target.onMessage(([data]) => server.send(data));
      target.onEnd(() => {
        if (target)
          // Could be due us closing.
          server.send(
            JSON.stringify({
              method: 'Target.targetDestroyed',
              params: { targetId: targetInfo.targetId, sessionId: targetInfo.targetId },
            }),
          );
      });
      result = {
        sessionId: targetInfo.targetId,
        __dynamicAttach: info.dynamicAttach ? true : undefined,
      };
    } else if (object.method === 'Target.detachFromTarget') {
      logger.info(LogTag.Runtime, 'Detach from target', object);
      if (target) {
        const t = target;
        target = undefined;
        t.dispose();
      } else {
        logger.warn(LogTag.Runtime, 'Detach without attach', object);
      }
      result = {};
    } else {
      target?.send(data);
      return;
    }

    server.send(JSON.stringify({ id: object.id, result }));
  });

  server.onEnd(() => {
    logger.info(LogTag.Runtime, 'SERVER CLOSED');
    target?.dispose();
  });
})();
