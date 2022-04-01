/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { sortKeys } from '../common/objUtils';
import strings from './strings';

process.stdout.write(JSON.stringify(sortKeys(strings)));
