/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { spawnSync } from 'child_process';
import { DefaultJsDebugPorts, IFindOpenPortOptions } from './findOpenPort';
import { randomInRange } from './random';

export { acquirePortNumber, IFindOpenPortOptions } from './findOpenPort';

export function findOpenPortSync({
  min = DefaultJsDebugPorts.Min,
  max = DefaultJsDebugPorts.Max,
  attempts = 1000,
}: Partial<IFindOpenPortOptions<never>> = {}) {
  const tester = makeTester();

  let port = randomInRange(min, max);
  for (let i = Math.min(attempts, max - min); i >= 0; i--) {
    if (tester(port)) {
      return port;
    }

    port = port === max - 1 ? min : port + 1;
  }

  throw new Error('No open port found');
}

const makeTester = () => (port: number) => {
  /*
    require('net')
      .createServer()
      .on('listening', () => process.exit(0))
      .on('error', () => process.exit(1))
      .listen(+process.env.PORT)
    */

  const r = spawnSync(
    process.execPath,
    [
      '-e',
      `require("net").createServer().on("listening",()=>process.exit(0)).on("error",()=>process.exit(1)).listen(+process.env.PORT)`,
    ],
    {
      env: {
        ...process.env,
        PORT: String(port),
        NODE_OPTIONS: undefined,
        ELECTRON_RUN_AS_NODE: '1',
      },
    },
  );

  return r.status === 0;
};
