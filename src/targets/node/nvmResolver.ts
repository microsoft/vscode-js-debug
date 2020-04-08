/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as path from 'path';
import * as fs from 'fs';
import {
  nvmHomeNotFound,
  nvmNotFound,
  nvmVersionNotFound,
  ProtocolError,
  nvsNotFound,
} from '../../dap/errors';
import { injectable } from 'inversify';
import { exists } from '../../common/fsUtils';
import { some } from '../../common/promiseUtil';

/**
 * Resolves the location of Node installation querying an nvm installation.
 */
export interface INvmResolver {
  /**
   * Returns a PATH segment to add by loading the given nvm version.
   * Throws a ProtocolError if the requested version is not found in the path.
   */
  resolveNvmVersionPath(version: string): Promise<{ directory: string; binary: string }>;
}

export const INvmResolver = Symbol('INvmResolver');

interface IVersionStringData {
  nvsFormat: boolean;
  remoteName: string;
  semanticVersion: string;
  arch: string;
}

const enum Vars {
  NvsHome = 'NVS_HOME',
  WindowsNvmHome = 'NVM_HOME',
  UnixNvmHome = 'NVM_DIR',
}

@injectable()
export class NvmResolver implements INvmResolver {
  constructor(
    private readonly env = process.env,
    private readonly arch = process.arch,
    private readonly platform = process.platform,
  ) {}

  public async resolveNvmVersionPath(version: string) {
    let nvsHome = this.env[Vars.NvsHome];
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

    let directory: string | undefined = undefined;
    const versionManagers: string[] = [];
    const versionData = this.parseVersionString(version);
    if (versionData.nvsFormat || nvsHome) {
      directory = await this.resolveNvs(nvsHome, versionData);
      if (!directory && versionData.nvsFormat) {
        throw new ProtocolError(nvmVersionNotFound(version, 'nvs'));
      }
      versionManagers.push('nvs');
    }

    if (!directory) {
      if (this.platform === 'win32') {
        if (this.env[Vars.WindowsNvmHome]) {
          directory = await this.resolveWindowsNvm(version);
          versionManagers.push('nvm-windows');
        }
      } else if (this.env[Vars.UnixNvmHome]) {
        directory = await this.resolveUnixNvm(version);
        versionManagers.push('nvm');
      }
    }

    if (!versionManagers.length) {
      throw new ProtocolError(nvmNotFound());
    }

    if (!directory || !(await exists(directory))) {
      throw new ProtocolError(nvmVersionNotFound(version, versionManagers.join('/')));
    }

    return { directory, binary: await this.getBinaryInFolder(directory) };
  }

  /**
   * Returns the Node binary in the given folder. In recent versions of x64
   * nvm on windows, nvm installs the exe as "node64" rather than "node".
   * This detects that.
   */
  private async getBinaryInFolder(dir: string) {
    if (await some(['node64.exe', 'node64'].map(exe => exists(path.join(dir, exe))))) {
      return 'node64';
    }

    return 'node';
  }

  private async resolveNvs(
    nvsHome: string | undefined,
    { remoteName, semanticVersion, arch }: IVersionStringData,
  ) {
    if (!nvsHome) {
      throw new ProtocolError(nvsNotFound());
    }

    const dir = this.findBinFolderForVersion(path.join(nvsHome, remoteName), semanticVersion, d =>
      fs.existsSync(path.join(d, arch)),
    );

    if (!dir) {
      return undefined;
    }

    return this.platform !== 'win32' ? path.join(dir, arch, 'bin') : path.join(dir, arch);
  }

  private async resolveUnixNvm(version: string) {
    // macOS and linux
    let nvmHome = this.env[Vars.UnixNvmHome];
    if (!nvmHome) {
      // if NVM_DIR is not set. Probe for '.nvm' directory instead
      const nvmDir = path.join(this.env['HOME'] || '', '.nvm');
      if (await exists(nvmDir)) {
        nvmHome = nvmDir;
      }
    }
    if (!nvmHome) {
      throw new ProtocolError(nvmNotFound());
    }
    const directory = this.findBinFolderForVersion(
      path.join(nvmHome, 'versions', 'node'),
      `v${version}`,
    );

    return directory ? path.join(directory, 'bin') : undefined;
  }

  private async resolveWindowsNvm(version: string) {
    const nvmHome = this.env[Vars.WindowsNvmHome];
    if (!nvmHome) {
      throw new ProtocolError(nvmHomeNotFound());
    }

    return this.findBinFolderForVersion(nvmHome, `v${version}`);
  }

  private findBinFolderForVersion(
    dir: string,
    version: string,
    extraTest?: (candidateDir: string) => void,
  ): string | undefined {
    if (!fs.existsSync(dir)) {
      return undefined;
    }

    const available = fs.readdirSync(dir);
    if (available.includes(version)) {
      return path.join(dir, version);
    }

    const best = available
      .filter(p => p.startsWith(`${version}.`))
      .sort(semverSortAscending)
      .filter(p => (extraTest ? extraTest(path.join(dir, p)) : true))
      .pop();

    return best ? path.join(dir, best) : undefined;
  }

  /**
   * Parses a node version string into remote name, semantic version, and architecture
   * components. Infers some unspecified components based on configuration.
   */
  private parseVersionString(versionString: string): IVersionStringData {
    // Pattern: (flavor?)/(v?)X.X.X/(arch?)
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

const semverSortAscending = (a: string, b: string) => {
  const matchA = /([0-9]+)\.([0-9]+)\.([0-9]+)/.exec(a);
  const matchB = /([0-9]+)\.([0-9]+)\.([0-9]+)/.exec(b);
  if (!matchA || !matchB) {
    return (matchB ? -1 : 0) + (matchA ? 1 : 0);
  }

  const [, aMajor, aMinor, aPatch] = matchA;
  const [, bMajor, bMinor, bPatch] = matchB;
  return (
    Number(aMajor) - Number(bMajor) ||
    Number(aMinor) - Number(bMinor) ||
    Number(aPatch) - Number(bPatch)
  );
};

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
      // eslint-disable-next-line
      const armVersion = (process.config.variables as any).arm_version;
      return armVersion ? 'armv' + armVersion + 'l' : 'arm';
    default:
      return arch;
  }
}
