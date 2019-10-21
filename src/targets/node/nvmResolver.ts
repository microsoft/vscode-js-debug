/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as path from 'path';
import * as fs from 'fs';
import { nvmHomeNotFound, nvmNotFound, nvmVersionNotFound } from '../../dap/errors';

/**
 * Resolves the location of Node installation querying an nvm installation.
 */
export interface INvmResolver {
  /**
   * Returns a PATH segment to add by loading the given nvm version.
   * Throws a ProtocolError if the requested version is not found in the path.
   */
  resolveNvmVersionPath(version: string): Promise<string>;
}

export class NvmResolver {
  constructor(
    private readonly env = process.env,
    private readonly arch = process.arch,
    private readonly platform = process.platform,
  ) {}

  public async resolveNvmVersionPath(version: string): Promise<string> {
    let bin: string | undefined = undefined;
    let versionManagerName: string | undefined = undefined;

    // first try the Node Version Switcher 'nvs'
    let nvsHome = this.env['NVS_HOME'];
    if (!nvsHome) {
      // NVS_HOME is not always set. Probe for 'nvs' directory instead
      const nvsDir =
        this.platform === 'win32'
          ? path.join(this.env['LOCALAPPDATA'] || '', 'nvs')
          : path.join(this.env['HOME'] || '', '.nvs');
      if (fs.existsSync(nvsDir)) {
        nvsHome = nvsDir;
      }
    }

    const { nvsFormat, remoteName, semanticVersion, arch } = this.parseVersionString(version);

    if (nvsFormat || nvsHome) {
      if (!nvsHome) {
        throw nvmNotFound();
      }

      bin = path.join(nvsHome, remoteName, semanticVersion, arch);
      if (this.platform !== 'win32') {
        bin = path.join(bin, 'bin');
      }
      versionManagerName = 'nvs';
    }

    if (!bin) {
      // now try the Node Version Manager 'nvm'
      if (this.platform === 'win32') {
        const nvmHome = this.env['NVM_HOME'];
        if (!nvmHome) {
          throw nvmHomeNotFound();
        }
        bin = this.findBinFolderForVersion(nvmHome, `v${version}`);
        versionManagerName = 'nvm-windows';
      } else {
        // macOS and linux
        let nvmHome = this.env['NVM_DIR'];
        if (!nvmHome) {
          // if NVM_DIR is not set. Probe for '.nvm' directory instead
          const nvmDir = path.join(this.env['HOME'] || '', '.nvm');
          if (fs.existsSync(nvmDir)) {
            nvmHome = nvmDir;
          }
        }
        if (!nvmHome) {
          throw nvmNotFound();
        }
        versionManagerName = 'nvm';
        bin = this.findBinFolderForVersion(path.join(nvmHome, 'versions', 'node'), `v${version}`);
        if (bin) {
          bin = path.join(bin, 'bin');
        }
      }
    }

    if (!bin || !fs.existsSync(bin)) {
      throw nvmVersionNotFound(version, versionManagerName || 'nvm');
    }

    return bin;
  }

  private findBinFolderForVersion(dir: string, version: string): string | undefined {
    if (!fs.existsSync(dir)) {
      return undefined;
    }

    const available = fs.readdirSync(dir);
    if (available.includes(version)) {
      return path.join(dir, version);
    }

    for (const candidate of available) {
      if (candidate.startsWith(`${version}.`)) {
        return path.join(dir, candidate);
      }
    }

    return undefined;
  }

  /**
   * Parses a node version string into remote name, semantic version, and architecture
   * components. Infers some unspecified components based on configuration.
   */
  private parseVersionString(versionString: string) {
    const versionRegex = /^(([\w-]+)\/)?(v?(\d+(\.\d+(\.\d+)?)?))(\/((x86)|(32)|((x)?64)|(arm\w*)|(ppc\w*)))?$/i;

    const match = versionRegex.exec(versionString);
    if (!match) {
      throw new Error('Invalid version string: ' + versionString);
    }

    const nvsFormat = !!(match[2] || match[8]);
    const remoteName = match[2] || 'node';
    const semanticVersion = match[4] || '';
    const arch = nvsStandardArchName(match[8] || this.arch);

    return { nvsFormat, remoteName, semanticVersion, arch };
  }
}

function nvsStandardArchName(arch: string) {
  switch (arch) {
    case '32':
    case 'x86':
    case 'ia32':
      return 'x86';
    case '64':
    case 'x64':
    case 'amd64':
      return 'x64';
    case 'arm':
      const arm_version = (process.config.variables as any).arm_version;
      return arm_version ? 'armv' + arm_version + 'l' : 'arm';
    default:
      return arch;
  }
}
