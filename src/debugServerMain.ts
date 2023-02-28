/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import 'reflect-metadata';
import { startDebugServer } from './debugServer';

let port = 0;
let host: string | undefined;
if (process.argv.length >= 3) {
  // Interpret the argument as either a port number, or 'address:port'.
  const address = process.argv[2];
  const colonIndex = address.lastIndexOf(':');
  if (colonIndex === -1) {
    port = +address;
  } else {
    host = address.substring(0, colonIndex);
    port = +address.substring(colonIndex + 1);
  }
}
startDebugServer(port, host);
