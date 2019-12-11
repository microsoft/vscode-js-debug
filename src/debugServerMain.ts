/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { startDebugServer } from './debugServer';

startDebugServer(process.argv.length >= 3 ? +process.argv[2] : 0);
