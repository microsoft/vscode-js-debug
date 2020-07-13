/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { expect } from 'chai';
import { join } from 'path';
import { SinonStub, stub } from 'sinon';
import { EnvironmentVars } from '../../common/environmentVars';
import { ErrorCodes } from '../../dap/errors';
import { ProtocolError } from '../../dap/protocolError';
import { NodeBinaryProvider } from '../../targets/node/nodeBinaryProvider';
import { testWorkspace } from '../test';
import { Logger } from '../../common/logging/logger';

describe('NodeBinaryProvider', () => {
  let p: NodeBinaryProvider;
  const env = (name: string) =>
    EnvironmentVars.empty.addToPath(join(testWorkspace, 'nodePathProvider', name));
  const binaryLocation = (name: string, binary = 'node') =>
    join(
      testWorkspace,
      'nodePathProvider',
      name,
      process.platform === 'win32' ? `${binary}.exe` : binary,
    );

  beforeEach(() => (p = new NodeBinaryProvider(Logger.null)));

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

  it('resolves the binary if given a package manager', async () => {
    const binary = await p.resolveAndValidate(env('up-to-date'), 'npm');
    expect(binary.path).to.equal(binaryLocation('up-to-date', 'npm'));
    expect(binary.majorVersion).to.equal(12);
  });

  it('still throws outdated through a package manager', async () => {
    try {
      await p.resolveAndValidate(env('outdated'), 'npm');
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).to.be.an.instanceOf(ProtocolError);
      expect(err.cause.id).to.equal(ErrorCodes.NodeBinaryOutOfDate);
    }
  });

  it('surpresses not found if a package manager exists', async () => {
    const binary = await p.resolveAndValidate(env('no-node'), 'npm');
    expect(binary.path).to.equal(binaryLocation('no-node', 'npm'));
    expect(binary.majorVersion).to.be.undefined;
  });

  it('allows overriding with an explicit version', async () => {
    const binary = await p.resolveAndValidate(env('outdated'), undefined, 12);
    expect(binary.path).to.equal(binaryLocation('outdated'));
    expect(binary.majorVersion).to.equal(12);
    expect(binary.canUseSpacesInRequirePath).to.be.true;
  });

  describe('electron versioning', () => {
    let getVersionText: SinonStub;
    let resolveBinaryLocation: SinonStub;

    beforeEach(() => {
      getVersionText = stub(p, 'getVersionText');
      resolveBinaryLocation = stub(p, 'resolveBinaryLocation');
      resolveBinaryLocation.withArgs('node').returns('/node');
    });

    it('remaps to node version on electron with .cmd', async () => {
      getVersionText.withArgs('/foo/electron.cmd').resolves('\nv6.1.2\n');
      getVersionText.withArgs('/node').resolves('v14.5.0');
      resolveBinaryLocation.withArgs('electron').returns('/foo/electron.cmd');

      const binary = await p.resolveAndValidate(EnvironmentVars.empty, 'electron');
      expect(binary.majorVersion).to.equal(12);
    });

    it('remaps to node version on electron with no ext', async () => {
      getVersionText.withArgs('/foo/electron').resolves('\nv6.1.2\n');
      getVersionText.withArgs('/node').resolves('v14.5.0');
      resolveBinaryLocation.withArgs('electron').returns('/foo/electron');

      const binary = await p.resolveAndValidate(EnvironmentVars.empty, 'electron');
      expect(binary.majorVersion).to.equal(12);
    });

    it('remaps electron 5', async () => {
      getVersionText.withArgs('/foo/electron').resolves('\nv5.1.2\n');
      getVersionText.withArgs('/node').resolves('v14.5.0');
      resolveBinaryLocation.withArgs('electron').returns('/foo/electron');

      const binary = await p.resolveAndValidate(EnvironmentVars.empty, 'electron');
      expect(binary.majorVersion).to.equal(10);
    });

    it('uses minimum node version', async () => {
      getVersionText.withArgs('/foo/electron').resolves('\nv9.0.0\n');
      getVersionText.withArgs('/node').resolves('v10.0.0');
      resolveBinaryLocation.withArgs('electron').returns('/foo/electron');

      const binary = await p.resolveAndValidate(EnvironmentVars.empty, 'electron');
      expect(binary.majorVersion).to.equal(10);
    });
  });
});
