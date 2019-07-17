/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as net from 'net';
import { WebSocketTransport, PipeTransport } from '../cdp/transport';

const targetInfo = JSON.parse(process.env.NODE_INSPECTOR_TARGET_INFO!);

process.on('exit', () => {
  process.kill(+targetInfo.targetId);
});

(async() => {
  const target = await WebSocketTransport.create(targetInfo.url);
  let server: PipeTransport;
  let pipe: any;
  await new Promise(f => pipe = net.createConnection(process.env.NODE_INSPECTOR_IPC!, f));
  server = new PipeTransport(pipe, pipe);
  server.send(JSON.stringify({ method: 'Target.targetCreated', params: { targetInfo } }));

  target.onmessage = data => server.send(data);
  server.onmessage = data => target.send(data);
  target.onclose = () => server.close();
  server.onclose = () => target.close();
})();
