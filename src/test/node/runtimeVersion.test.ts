/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { expect } from 'chai';
import { promises as fsPromises } from 'fs';
import * as path from 'path';
import { LocalFsUtils } from '../../common/fsUtils';
import { ProtocolError } from '../../dap/protocolError';
import { INvmResolver, NvmResolver } from '../../targets/node/nvmResolver';
import { createFileTree } from '../createFileTree';
import { testFixturesDir, testWorkspace } from '../test';

const fsUtils = new LocalFsUtils(fsPromises);

describe('runtimeVersion', () => {
  let resolver: INvmResolver;

  it('fails if no nvm/s present', async () => {
    resolver = new NvmResolver(fsUtils, {}, 'x64', 'linux', testWorkspace);
    await expect(resolver.resolveNvmVersionPath('13')).to.eventually.be.rejectedWith(
      ProtocolError,
      /requires Node.js version manager/,
    );
  });

  describe('fall throughs', () => {
    beforeEach(() => {
      createFileTree(testFixturesDir, {
        'nvs/node/13.12.0/x64/bin/node': '',
        'nvs/node/13.11.0/x86/bin/node': '',
        'nvm/versions/node/v13.11.0/bin/node': '',
        'fnm/node-versions/v13.10.0/installation/bin/node': '',
      });

      resolver = new NvmResolver(
        fsUtils,
        {
          NVS_HOME: path.join(testFixturesDir, 'nvs'),
          NVM_DIR: path.join(testFixturesDir, 'nvm'),
          FNM_DIR: path.join(testFixturesDir, 'fnm'),
        },
        'x64',
        'linux',
        testWorkspace,
      );
    });

    it('attempts multiple lookup to get the right version', async () => {
      const { directory: a } = await resolver.resolveNvmVersionPath('13.12');
      expect(a).to.equal(path.join(testFixturesDir, 'nvs/node/13.12.0/x64/bin'));

      const { directory: b } = await resolver.resolveNvmVersionPath('13.11');
      expect(b).to.equal(path.join(testFixturesDir, 'nvm/versions/node/v13.11.0/bin'));

      const { directory: c } = await resolver.resolveNvmVersionPath('13.10');
      expect(c).to.equal(
        path.join(testFixturesDir, 'fnm/node-versions/v13.10.0/installation/bin'),
      );

      await expect(resolver.resolveNvmVersionPath('14')).to.eventually.be.rejectedWith(
        ProtocolError,
        /not installed using version manager nvs\/nvm\/fnm/,
      );
    });

    it('requires nvs for a specific architecture', async () => {
      resolver = new NvmResolver(
        fsUtils,
        { NVM_DIR: path.join(testFixturesDir, 'nvm') },
        'x64',
        'linux',
        testWorkspace,
      );
      await expect(resolver.resolveNvmVersionPath('13.11/x64')).to.eventually.be.rejectedWith(
        ProtocolError,
        /architecture requires 'nvs' to be installed/,
      );
    });

    it('does not fall through if requesting a specific nvs architecture', async () => {
      await expect(resolver.resolveNvmVersionPath('13.11/x64')).to.eventually.be.rejectedWith(
        ProtocolError,
        /not installed/,
      );
    });
  });

  describe('nvs support', () => {
    beforeEach(() => {
      createFileTree(testFixturesDir, {
        'node/13.12.0/x64/bin/node': '',
        'node/13.4.0/x86/bin/node': '',
        'node/13.3.0/x64/bin/node': '',
        'node/13.3.1/x64/bin/node64.exe': '',
        'node/13.invalid/x64/bin/node': '',
      });

      resolver = new NvmResolver(
        fsUtils,
        { NVS_HOME: testFixturesDir },
        'x64',
        'linux',
        testWorkspace,
      );
    });

    it('gets an exact match', async () => {
      const { directory, binary } = await resolver.resolveNvmVersionPath('13.3.0');
      expect(directory).to.equal(path.join(testFixturesDir, 'node/13.3.0/x64/bin'));
      expect(binary).to.equal('node');
    });

    it('resolves node64', async () => {
      const { directory, binary } = await resolver.resolveNvmVersionPath('13.3.1');
      expect(directory).to.equal(path.join(testFixturesDir, 'node/13.3.1/x64/bin'));
      expect(binary).to.equal('node64');
    });

    it('gets the best matching version', async () => {
      const { directory } = await resolver.resolveNvmVersionPath('13');
      expect(directory).to.equal(path.join(testFixturesDir, 'node/13.12.0/x64/bin'));
    });

    it('throws if no version match', async () => {
      await expect(resolver.resolveNvmVersionPath('14')).to.eventually.be.rejectedWith(
        ProtocolError,
        /not installed/,
      );
    });

    it('throws on none for specific architecture', async () => {
      await expect(resolver.resolveNvmVersionPath('13.4.0')).to.eventually.be.rejectedWith(
        ProtocolError,
        /not installed/,
      );
    });

    it('gets a specific architecture', async () => {
      const { directory } = await resolver.resolveNvmVersionPath('13/x86');
      expect(directory).to.equal(path.join(testFixturesDir, 'node/13.4.0/x86/bin'));
    });

    it('omits the bin directory on windows', async () => {
      resolver = new NvmResolver(
        fsUtils,
        { NVS_HOME: testFixturesDir },
        'x64',
        'win32',
        testWorkspace,
      );
      const { directory } = await resolver.resolveNvmVersionPath('13.3.0');
      expect(directory).to.equal(path.join(testFixturesDir, 'node/13.3.0/x64'));
    });
  });

  describe('nvm windows', () => {
    beforeEach(() => {
      createFileTree(testFixturesDir, {
        'v13.12.0/node.exe': '',
        'v13.3.0/node.exe': '',
        'v13.3.1/node64.exe': '',
        'v13.invalid/node.exe': '',
      });

      resolver = new NvmResolver(
        fsUtils,
        { NVM_HOME: testFixturesDir },
        'x64',
        'win32',
        testWorkspace,
      );
    });

    it('gets an exact match', async () => {
      const { directory, binary } = await resolver.resolveNvmVersionPath('13.3.0');
      expect(directory).to.equal(path.join(testFixturesDir, 'v13.3.0'));
      expect(binary).to.equal('node');
    });

    it('resolves node64', async () => {
      const { directory, binary } = await resolver.resolveNvmVersionPath('13.3.1');
      expect(directory).to.equal(path.join(testFixturesDir, 'v13.3.1'));
      expect(binary).to.equal('node64');
    });

    it('gets the best matching version', async () => {
      const { directory } = await resolver.resolveNvmVersionPath('13');
      expect(directory).to.equal(path.join(testFixturesDir, 'v13.12.0'));
    });

    it('throws if no version match', async () => {
      await expect(resolver.resolveNvmVersionPath('14')).to.eventually.be.rejectedWith(
        ProtocolError,
        /not installed/,
      );
    });
  });

  describe('nvm osx', () => {
    beforeEach(() => {
      createFileTree(testFixturesDir, {
        'versions/node/v13.12.0/bin/node': '',
        'versions/node/v13.3.0/bin/node': '',
        'versions/node/v13.3.1/bin/node64': '',
        'versions/node/v13.invalid/bin/node': '',
      });

      resolver = new NvmResolver(
        fsUtils,
        { NVM_DIR: testFixturesDir },
        'x64',
        'linux',
        testWorkspace,
      );
    });

    it('gets an exact match', async () => {
      const { directory, binary } = await resolver.resolveNvmVersionPath('13.3.0');
      expect(directory).to.equal(path.join(testFixturesDir, 'versions/node/v13.3.0/bin'));
      expect(binary).to.equal('node');
    });

    it('resolves node64', async () => {
      const { directory, binary } = await resolver.resolveNvmVersionPath('13.3.1');
      expect(directory).to.equal(path.join(testFixturesDir, 'versions/node/v13.3.1/bin'));
      expect(binary).to.equal('node64');
    });

    it('gets the best matching version', async () => {
      const { directory } = await resolver.resolveNvmVersionPath('13');
      expect(directory).to.equal(path.join(testFixturesDir, 'versions/node/v13.12.0/bin'));
    });

    it('throws if no version match', async () => {
      await expect(resolver.resolveNvmVersionPath('14')).to.eventually.be.rejectedWith(
        ProtocolError,
        /not installed/,
      );
    });
  });

  describe('fnm', () => {
    beforeEach(() => {
      createFileTree(testFixturesDir, {
        'node-versions/v13.12.0/installation/bin/node': '',
        'node-versions/v13.3.0/installation/bin/node': '',
        'node-versions/v13.invalid/installation/bin/node': '',
      });

      resolver = new NvmResolver(
        fsUtils,
        { FNM_DIR: testFixturesDir },
        'x64',
        'linux',
        testWorkspace,
      );
    });

    it('gets an exact match', async () => {
      const { directory, binary } = await resolver.resolveNvmVersionPath('13.3.0');
      expect(directory).to.equal(
        path.join(testFixturesDir, 'node-versions/v13.3.0/installation/bin'),
      );
      expect(binary).to.equal('node');
    });

    it('gets the best matching version', async () => {
      const { directory } = await resolver.resolveNvmVersionPath('13');
      expect(directory).to.equal(
        path.join(testFixturesDir, 'node-versions/v13.12.0/installation/bin'),
      );
    });

    it('throws if no version match', async () => {
      await expect(resolver.resolveNvmVersionPath('14')).to.eventually.be.rejectedWith(
        ProtocolError,
        /not installed/,
      );
    });
  });
});
