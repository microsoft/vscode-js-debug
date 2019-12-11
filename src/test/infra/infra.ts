/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { itIntegrates } from '../testIntegrationUtils';

describe('infra', () => {
  itIntegrates('initialize', async ({ r }) => {
    r.log(await r.initialize);
    r.assertLog();
  });
});
