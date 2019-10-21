// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { itIntegrates } from '../testIntegrationUtils';

describe('infra', () => {
  itIntegrates('initialize', async ({ r }) => {
    r.log(await r.initialize);
    r.assertLog();
  });
});
