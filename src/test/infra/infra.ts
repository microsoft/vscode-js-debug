// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { TestRoot } from '../test';
import { itIntegrates } from '../testIntegrationUtils';

describe('infra', () => {
  itIntegrates('initialize', async ({ r }: { r: TestRoot }) => {
    r.log(await r.initialize);
    r.assertLog();
  });
});
