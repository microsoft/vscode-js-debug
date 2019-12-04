// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as net from 'net';
import { WebSocketTransport, PipeTransport } from '../../cdp/transport';
import { IWatchdogInfo } from './watchdogSpawn';
import { NeverCancelled } from '../../common/cancellation';

const info: IWatchdogInfo = JSON.parse(process.env.NODE_INSPECTOR_INFO!);

function debugLog(text: string) {
  // require('fs').appendFileSync(require('path').join(require('os').homedir(), 'watchdog.txt'), `WATCHDOG [${info.pid}] ${text} (${info.scriptName})\n`);
}

process.on('uncaughtException', e => debugLog(`Uncaught exception: ${e.stack || e}`));
process.on('unhandledRejection', e => debugLog(`Unhandled rejection: ${e}`));

process.on('exit', () => {
  debugLog('KILL');
  if (info.pid && !info.dynamicAttach) {
    process.kill(Number(info.pid));
  }
});

(async () => {
  debugLog('CONNECTED TO TARGET');
  let server: PipeTransport;
  let pipe: any;
  await new Promise(f => (pipe = net.createConnection(process.env.NODE_INSPECTOR_IPC!, f)));
  server = new PipeTransport(pipe);

  const targetInfo = {
    targetId: info.pid || '0',
    type: info.waitForDebugger ? 'waitingForDebugger' : '',
    title: info.scriptName,
    url: 'file://' + info.scriptName,
    openerId: info.ppid,
  };

  server.send(JSON.stringify({ method: 'Target.targetCreated', params: { targetInfo } }));
  debugLog('CONNECTED TO SERVER');

  let target: WebSocketTransport | undefined;

  server.onmessage = async data => {
    if (!data.includes('Target.attachToTarget') && !data.includes('Target.detachFromTarget')) {
      target!.send(data);
      return;
    }

    let result: any = {};
    const object = JSON.parse(data);

    if (object.method === 'Target.attachToTarget') {
      debugLog('ATTACH TO TARGET');
      if (target) {
        target.close();
        target = undefined;
      }
      target = await WebSocketTransport.create(info.inspectorURL, NeverCancelled);
      target.onmessage = data => server.send(data);
      target.onend = () => {
        if (target)
          // Could be due us closing.
          server.send(
            JSON.stringify({
              method: 'Target.targetDestroyed',
              params: { targetId: targetInfo.targetId, sessionId: targetInfo.targetId },
            }),
          );
      };
      result = { sessionId: targetInfo.targetId };
      if (info.dynamicAttach) {
        result.__dynamicAttach = true;
      }
    } else if (object.method === 'Target.detachFromTarget') {
      debugLog('DETACH FROM TARGET');
      if (target) {
        const t = target;
        target = undefined;
        t.close();
      } else {
        debugLog('DETACH WITHOUT ATTACH');
      }
      result = {};
    } else {
      target!.send(data);
      return;
    }

    server.send(JSON.stringify({ id: object.id, result }));
  };

  server.onend = () => {
    debugLog('SERVER CLOSED');
    if (target) target.close();
  };
})();
