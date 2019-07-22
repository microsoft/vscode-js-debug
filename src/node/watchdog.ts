// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as net from 'net';
import { WebSocketTransport, PipeTransport } from '../cdp/transport';

const targetInfo = JSON.parse(process.env.NODE_INSPECTOR_TARGET_INFO!);

function debugLog(text: string) {
  // require('fs').appendFileSync('LOG.txt', `[${targetInfo.targetId}] ${text} (${targetInfo.title})\n`);
}

process.on('exit', () => {
  debugLog('KILL');
  process.kill(+targetInfo.targetId);
});

(async() => {
  const target = await WebSocketTransport.create(targetInfo.url);
  debugLog('CONNECTED TO TARGET');
  let server: PipeTransport;
  let pipe: any;
  await new Promise(f => pipe = net.createConnection(process.env.NODE_INSPECTOR_IPC!, f));
  server = new PipeTransport(pipe);
  server.send(JSON.stringify({ method: 'Target.targetCreated', params: { targetInfo } }));
  debugLog('CONNECTED TO SERVER');

  target.onmessage = data => server.send(data);
  server.onmessage = data => target.send(data);
  target.onclose = () => {
    debugLog('TARGET CLOSED');
    server.close();
  }
  server.onclose = () => {
    debugLog('SERVER CLOSED');
    target.close();
  }
})();
