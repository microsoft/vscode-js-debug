// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { startDebugServer } from './debugServer';

startDebugServer(process.argv.length >= 3 ? +process.argv[2] : 0)
