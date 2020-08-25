/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { expect } from 'chai';
import { promises as fsPromises } from 'fs';
import { join } from 'path';
import { SinonStub, stub } from 'sinon';
import { EnvironmentVars } from '../../common/environmentVars';
import { Logger } from '../../common/logging/logger';
import { Semver } from '../../common/semver';
import { ErrorCodes } from '../../dap/errors';
import { ProtocolError } from '../../dap/protocolError';
import { Capability, NodeBinary, NodeBinaryProvider } from '../../targets/node/nodeBinaryProvider';
import { testWorkspace } from '../../test/test';

describe('NodeBinaryProvider', function () {
  this.timeout(30 * 1000); // windows lookups in CI seem to be very slow sometimes

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

  beforeEach(() => (p = new NodeBinaryProvider(Logger.null, fsPromises)));

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
    expect(binary.version).to.deep.equal(new Semver(12, 0, 0));
    expect(binary.isPreciselyKnown).to.be.true;
    expect(binary.has(Capability.UseSpacesInRequirePath)).to.be.true;
  });

  if (process.platform === 'win32') {
    it('resolves absolute paths with extension on windows', async () => {
      const binary = await p.resolveAndValidate(
        new EnvironmentVars(process.env).addToPath(
          join(testWorkspace, 'nodePathProvider', 'no-node'),
        ),
        'babel',
      );
      expect(binary.path).to.equal(join(testWorkspace, 'nodePathProvider', 'no-node', 'babel.cmd'));
    });
  }

  it('works if up to date', async () => {
    const binary = await p.resolveAndValidate(env('up-to-date'));
    expect(binary.path).to.equal(binaryLocation('up-to-date'));
    // hit the cached path:
    expect(await p.resolveAndValidate(env('up-to-date'))).to.equal(binary);
  });

  it('resolves the binary if given a package manager', async () => {
    const binary = await p.resolveAndValidate(env('up-to-date'), 'npm');
    expect(binary.path).to.equal(binaryLocation('up-to-date', 'npm'));
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
    expect(binary.isPreciselyKnown).to.be.false;
    expect(binary.version).to.be.undefined;
  });

  it('allows overriding with an explicit version', async () => {
    const binary = await p.resolveAndValidate(env('outdated'), undefined, 12);
    expect(binary.path).to.equal(binaryLocation('outdated'));
    expect(binary.version).to.deep.equal(new Semver(12, 0, 0));
    expect(binary.has(Capability.UseSpacesInRequirePath)).to.be.true;
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
      expect(binary.version).to.deep.equal(new Semver(12, 0, 0));
    });

    it('remaps to node version on electron with no ext', async () => {
      getVersionText.withArgs('/foo/electron').resolves('\nv6.1.2\n');
      getVersionText.withArgs('/node').resolves('v14.5.0');
      resolveBinaryLocation.withArgs('electron').returns('/foo/electron');

      const binary = await p.resolveAndValidate(EnvironmentVars.empty, 'electron');
      expect(binary.version).to.deep.equal(new Semver(12, 0, 0));
    });

    it('remaps electron 5', async () => {
      getVersionText.withArgs('/foo/electron').resolves('\nv5.1.2\n');
      getVersionText.withArgs('/node').resolves('v14.5.0');
      resolveBinaryLocation.withArgs('electron').returns('/foo/electron');

      const binary = await p.resolveAndValidate(EnvironmentVars.empty, 'electron');
      expect(binary.version).to.deep.equal(new Semver(10, 0, 0));
    });

    it('uses minimum node version', async () => {
      getVersionText.withArgs('/foo/electron').resolves('\nv9.0.0\n');
      getVersionText.withArgs('/node').resolves('v10.0.0');
      resolveBinaryLocation.withArgs('electron').returns('/foo/electron');

      const binary = await p.resolveAndValidate(EnvironmentVars.empty, 'electron');
      expect(binary.version).to.deep.equal(new Semver(10, 0, 0));
    });

    it('assumes snap binaries are good', async () => {
      resolveBinaryLocation.withArgs('node').returns('/snap/bin/node');

      const binary = await p.resolveAndValidate(EnvironmentVars.empty);
      expect(binary.path).to.equal('/snap/bin/node');
      expect(binary.version).to.be.undefined;
      expect(getVersionText.called).to.be.false;
    });
  });
});

describe('NodeBinary', () => {
  const matrix = [
    {
      v: '10.0.0',
      c: { [Capability.UseInspectPublishUid]: false, [Capability.UseSpacesInRequirePath]: false },
    },
    {
      v: '12.0.0',
      c: { [Capability.UseInspectPublishUid]: false, [Capability.UseSpacesInRequirePath]: true },
    },
    {
      v: '12.8.0',
      c: { [Capability.UseInspectPublishUid]: true, [Capability.UseSpacesInRequirePath]: true },
    },
  ];

  for (const { v, c } of matrix) {
    it(`capabilities for ${v}`, () => {
      const b = new NodeBinary('node', Semver.parse(v));
      for (const [capability, expected] of Object.entries(c)) {
        expect(b.has(Number(capability) as Capability)).to.equal(expected, capability);
      }
    });
  }

  it('deals with imprecise capabilities', () => {
    const b1 = new NodeBinary('', undefined);
    expect(b1.has(Capability.UseSpacesInRequirePath)).to.be.true;
    expect(b1.has(Capability.UseSpacesInRequirePath, false)).to.be.false;

    const b2 = new NodeBinary('', new Semver(12, 0, 0));
    expect(b2.has(Capability.UseSpacesInRequirePath)).to.be.true;
    expect(b2.has(Capability.UseSpacesInRequirePath, false)).to.be.true;
  });
});
