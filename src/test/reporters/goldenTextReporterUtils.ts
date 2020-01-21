/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as mocha from 'mocha';
import { GoldenText } from '../goldenText';

export interface IGoldenReporterTextTest extends mocha.Runnable {
  goldenText: GoldenText;
}
