/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { readFileRaw } from '../common/fsUtils';

process.stdout.write(readFileRaw('../../package.nls.json'));
