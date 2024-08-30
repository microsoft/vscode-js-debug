/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { expect } from 'chai';
import { DefaultJsDebugPorts } from '../common/findOpenPort';
import { delay } from '../common/promiseUtil';
import { PortLeaseTracker } from './portLeaseTracker';

describe('PortLeaseTracker', () => {
  it('registers in use and not in use', async () => {
    const l = new PortLeaseTracker('local');
    expect(await l.isRegistered(1000)).to.be.false;
    l.register(1000);
    expect(await l.isRegistered(1000)).to.be.true;
  });

  it('does not delay for ports outside default range', async () => {
    const l = new PortLeaseTracker('local');
    expect(await Promise.race([l.isRegistered(1000), delay(5).then(() => 'error')])).to.be
      .false;
  });

  it('delays for ports in range', async () => {
    const l = new PortLeaseTracker('local');
    const p = DefaultJsDebugPorts.Min;
    setTimeout(() => l.register(p), 20);
    expect(await l.isRegistered(p)).to.be.true;
  });

  it('mandates correctly', async () => {
    expect(new PortLeaseTracker('local').isMandated).to.be.false;
    expect(new PortLeaseTracker('remote').isMandated).to.be.true;
  });
});
