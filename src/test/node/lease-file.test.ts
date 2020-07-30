/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { expect } from 'chai';
import { delay } from '../../common/promiseUtil';
import { LeaseFile } from '../../targets/node/lease-file';

describe('node lease file', () => {
  let file: LeaseFile;
  beforeEach(() => (file = new LeaseFile()));
  afterEach(() => file.dispose());

  it('says the lease is not valid for missing files', async () => {
    expect(LeaseFile.isValid('does-not-exist.txt')).to.be.false;
  });

  it('says the lease is not valid if too far in the past', async () => {
    await file.touch(() => Date.now() - 5000);
    expect(LeaseFile.isValid(file.path)).to.be.false;
  });

  it('says the lease is valid if recent', async () => {
    await file.touch(() => Date.now());
    expect(LeaseFile.isValid(file.path)).to.be.true;
  });

  it('truncates and updates on touches', async () => {
    await file.touch(() => Date.now() - 5000);
    await file.touch(() => Date.now());
    expect(LeaseFile.isValid(file.path)).to.be.true;
  });

  it('disposes the file', async () => {
    await file.touch(() => Date.now());
    await file.dispose();
    expect(LeaseFile.isValid(file.path)).to.be.false;
  });

  it('disposes the touch loop', async () => {
    await file.startTouchLoop();
    await file.dispose();
    await delay(1200);
    expect(LeaseFile.isValid(file.path)).to.be.false;
  });
});
