import { expect } from 'chai';
/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
import { itIntegrates } from '../testIntegrationUtils';

describe('performance', () => {
  itIntegrates('gets performance information', async ({ r }) => {
    const p = await r.launchUrlAndLoad('index.html');
    const res = await p.dap.getPerformance({});
    expect(res.error).to.be.undefined;
    expect(res.metrics).to.not.be.empty;
  });
});
