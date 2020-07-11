/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { injectable, inject } from 'inversify';
import { basename, isAbsolute } from 'path';
import { EnvironmentVars } from '../../common/environmentVars';
import { ILogger, LogTag } from '../../common/logging';
import { findInPath } from '../../common/pathUtils';
import { spawnAsync } from '../../common/processUtils';
import { cannotFindNodeBinary, ErrorCodes, nodeBinaryOutOfDate } from '../../dap/errors';
import { ProtocolError } from '../../dap/protocolError';

export const INodeBinaryProvider = Symbol('INodeBinaryProvider');

/**
 * DTO returned from the NodeBinaryProvider.
 */
export class NodeBinary {
  public get canUseSpacesInRequirePath() {
    return this.majorVersion ? this.majorVersion >= 12 : true;
  }

  constructor(public readonly path: string, public majorVersion: number | undefined) {}
}

const exeRe = /^(node|electron)(64)?(\.exe|\.cmd)?$/i;

/**
 * Mapping of electron versions to *effective* node versions. This is not
 * as simple as it looks. Electron bundles their own Node version, but that
 * Node version is not actually the same as the released version. For example
 * Electron 5 is Node 12 but doesn't contain the NODE_OPTIONS parsing fixes
 * that Node 12.0.0 does.
 *
 * todo: we should move to individual feature flags if/when we need additional
 * functionality here.
 */
const electronNodeVersion = new Map<number, number>([
  [11, 12],
  [10, 12],
  [9, 12],
  [8, 12],
  [7, 12],
  [6, 12],
  [5, 10], // 12, but doesn't include the NODE_OPTIONS parsing fixes
  [4, 10],
  [3, 10],
  [2, 8],
  [1, 8], // 7 earlier, but that will throw an error -- at least try
]);

/**
 * Utility that resolves a path to Node.js and validates
 * it's a debuggable version./
 */
@injectable()
export class NodeBinaryProvider {
  /**
   * A set of binary paths we know are good and which can skip additional
   * validation. We don't store bad mappings, because a user might reinstall
   * or upgrade node in-place after we tell them it's outdated.
   */
  private readonly knownGoodMappings = new Map<string, NodeBinary>();

  constructor(@inject(ILogger) private readonly logger: ILogger) {}

  /**
   * Validates the path and returns an absolute path to the Node binary to run.
   */
  public async resolveAndValidate(
    env: EnvironmentVars,
    executable = 'node',
    explicitVersion?: number,
  ): Promise<NodeBinary> {
    const location = this.resolveBinaryLocation(executable, env);
    this.logger.info(LogTag.RuntimeLaunch, 'Using binary at', { location, executable });
    if (!location) {
      throw new ProtocolError(cannotFindNodeBinary(executable));
    }

    if (explicitVersion) {
      return new NodeBinary(location, explicitVersion);
    }

    // If the runtime executable doesn't look like Node.js (could be a shell
    // script that boots Node by itself, for instance) try to find Node itself
    // on the path as a fallback.
    const exeInfo = exeRe.exec(basename(location).toLowerCase());
    if (!exeInfo) {
      try {
        const realBinary = await this.resolveAndValidate(env, 'node');
        return new NodeBinary(location, realBinary.majorVersion);
      } catch (e) {
        // if we verified it's outdated, still throw the error. If it's not
        // found, at least try to run it since the package manager exists.
        if ((e as ProtocolError).cause.id === ErrorCodes.NodeBinaryOutOfDate) {
          throw e;
        }

        return new NodeBinary(location, undefined);
      }
    }

    const knownGood = this.knownGoodMappings.get(location);
    if (knownGood) {
      return knownGood;
    }

    // match the "12" in "v12.34.56"
    const version = await this.getVersionText(location);
    this.logger.info(LogTag.RuntimeLaunch, 'Discovered version', { version: version.trim() });

    const majorVersionMatch = /v([0-9]+)\./.exec(version);
    if (!majorVersionMatch) {
      throw new ProtocolError(nodeBinaryOutOfDate(version.trim(), location));
    }

    let majorVersion = Number(majorVersionMatch[1]);

    // remap the node version bundled if we're running electron
    if (exeInfo[1] === 'electron') {
      majorVersion = electronNodeVersion.get(majorVersion) ?? 12;
    }

    if (majorVersion < 8) {
      throw new ProtocolError(nodeBinaryOutOfDate(version.trim(), location));
    }

    const entry = new NodeBinary(location, majorVersion);
    this.knownGoodMappings.set(location, entry);
    return entry;
  }

  public resolveBinaryLocation(executable: string, env: EnvironmentVars) {
    return executable && isAbsolute(executable) ? executable : findInPath(executable, env.value);
  }

  public async getVersionText(binary: string) {
    try {
      const { stdout } = await spawnAsync(binary, ['--version'], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
      });
      return stdout;
    } catch {
      throw new ProtocolError(cannotFindNodeBinary(binary));
    }
  }
}
