/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { NodePathProvider } from '../../targets/node/nodePathProvider';
import { join } from 'path';
import { expect } from 'chai';
import { testWorkspace } from '../test';
import { EnvironmentVars } from '../../common/environmentVars';
import { ProtocolError, ErrorCodes } from '../../dap/errors';

describe('NodePathProvider', () => {
  let p: NodePathProvider;
  const env = EnvironmentVars.empty.addToPath(join(testWorkspace, 'nodePathProvider'));
  const binaryLocation = (name: string) =>
    join(testWorkspace, 'nodePathProvider', name + (process.platform === 'win32' ? '.exe' : ''));

  beforeEach(() => (p = new NodePathProvider()));

  it('rejects not found', async () => {
    try {
      await p.resolveAndValidate(env, 'not-found');
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).to.be.an.instanceOf(ProtocolError);
      expect(err.cause.id).to.equal(ErrorCodes.CannotFindNodeBinary);
    }
  });

  it('rejects outdated', async () => {
    try {
      await p.resolveAndValidate(env, 'outdated');
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).to.be.an.instanceOf(ProtocolError);
      expect(err.cause.id).to.equal(ErrorCodes.NodeBinaryOutOfDate);
    }
  });

  it('resolves absolute paths', async () => {
    expect(
      await p.resolveAndValidate(EnvironmentVars.empty, binaryLocation('up-to-date')),
    ).to.equal(binaryLocation('up-to-date'));
  });

  it('works if up to date', async () => {
    expect(await p.resolveAndValidate(env, 'up-to-date')).to.equal(binaryLocation('up-to-date'));
    // hit the cached path:
    await p.resolveAndValidate(env, 'up-to-date');
  });
});
