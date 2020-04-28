/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { NodeBinaryProvider } from '../../targets/node/nodeBinaryProvider';
import { join } from 'path';
import { expect } from 'chai';
import { testWorkspace } from '../test';
import { EnvironmentVars } from '../../common/environmentVars';
import { ProtocolError, ErrorCodes } from '../../dap/errors';

describe('NodeBinaryProvider', () => {
  let p: NodeBinaryProvider;
  const env = (name: string) =>
    EnvironmentVars.empty.addToPath(join(testWorkspace, 'nodePathProvider', name));
  const binaryLocation = (name: string) =>
    join(
      testWorkspace,
      'nodePathProvider',
      name,
      process.platform === 'win32' ? 'node.exe' : 'node',
    );

  beforeEach(() => (p = new NodeBinaryProvider()));

  it('rejects not found', async () => {
    try {
      await p.resolveAndValidate(env('not-found'), 'node');
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).to.be.an.instanceOf(ProtocolError);
      expect(err.cause.id).to.equal(ErrorCodes.CannotFindNodeBinary);
    }
  });

  it('rejects outdated', async () => {
    try {
      await p.resolveAndValidate(env('outdated'), 'node');
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).to.be.an.instanceOf(ProtocolError);
      expect(err.cause.id).to.equal(ErrorCodes.NodeBinaryOutOfDate);
    }
  });

  it('resolves absolute paths', async () => {
    const binary = await p.resolveAndValidate(EnvironmentVars.empty, binaryLocation('up-to-date'));
    expect(binary.path).to.equal(binaryLocation('up-to-date'));
    expect(binary.majorVersion).to.equal(12);
    expect(binary.canUseSpacesInRequirePath).to.be.true;
  });

  it('works if up to date', async () => {
    const binary = await p.resolveAndValidate(env('up-to-date'));
    expect(binary.path).to.equal(binaryLocation('up-to-date'));
    // hit the cached path:
    expect(await p.resolveAndValidate(env('up-to-date'))).to.equal(binary);
  });
});
