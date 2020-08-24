/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { inject, injectable } from 'inversify';
import { basename, isAbsolute } from 'path';
import * as nls from 'vscode-nls';
import { EnvironmentVars } from '../../common/environmentVars';
import { ILogger, LogTag } from '../../common/logging';
import { findExecutable, findInPath } from '../../common/pathUtils';
import { spawnAsync } from '../../common/processUtils';
import { Semver } from '../../common/semver';
import { cannotFindNodeBinary, ErrorCodes, nodeBinaryOutOfDate } from '../../dap/errors';
import { ProtocolError } from '../../dap/protocolError';
import { FS, FsPromises } from '../../ioc-extras';

const localize = nls.loadMessageBundle();

export const INodeBinaryProvider = Symbol('INodeBinaryProvider');

export const enum Capability {
  UseSpacesInRequirePath,
  UseInspectPublishUid,
}

/**
 * If the Node binary supports it, adds an option to the NODE_OPTIONS that
 * prevents spewing extra debug info to the console.
 * @see https://github.com/microsoft/vscode-js-debug/issues/558
 */
export function hideDebugInfoFromConsole(binary: NodeBinary, env: EnvironmentVars) {
  return binary.has(Capability.UseInspectPublishUid)
    ? env.merge({ NODE_OPTIONS: `${env.lookup('NODE_OPTIONS') ?? ''} --inspect-publish-uid=http` })
    : env;
}

const assumedVersion = new Semver(12, 0, 0);
const minimumVersion = new Semver(8, 0, 0);

/**
 * DTO returned from the NodeBinaryProvider.
 */
export class NodeBinary {
  /**
   * Gets whether this version was detected exactly, or just assumed.
   */
  public get isPreciselyKnown() {
    return this.version !== undefined;
  }

  private capabilities = new Set<Capability>();

  constructor(public readonly path: string, public version: Semver | undefined) {
    if (version === undefined) {
      version = assumedVersion;
    }

    if (version.gte(new Semver(12, 0, 0))) {
      this.capabilities.add(Capability.UseSpacesInRequirePath);
    }

    if (version.gte(new Semver(12, 6, 0))) {
      this.capabilities.add(Capability.UseInspectPublishUid);
    }
  }

  /**
   * Gets whether the Node program has the capability. If `defaultIfImprecise`
   * is passed and the Node Binary's version is not exactly know, that default
   * will be returned instead.
   */
  public has(capability: Capability, defaultIfImprecise?: boolean): boolean {
    if (!this.isPreciselyKnown && defaultIfImprecise !== undefined) {
      return defaultIfImprecise;
    }

    return this.capabilities.has(capability);
  }
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
const electronNodeVersion = new Map<number, Semver>([
  [11, new Semver(12, 0, 0)],
  [10, new Semver(12, 0, 0)],
  [9, new Semver(12, 0, 0)],
  [8, new Semver(12, 0, 0)],
  [7, new Semver(12, 0, 0)],
  [6, new Semver(12, 0, 0)],
  [5, new Semver(10, 0, 0)], // 12, but doesn't include the NODE_OPTIONS parsing fixes
  [4, new Semver(10, 0, 0)],
  [3, new Semver(10, 0, 0)],
  [2, new Semver(8, 0, 0)],
  [1, new Semver(8, 0, 0)], // 7 earlier, but that will throw an error -- at least try
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

  constructor(
    @inject(ILogger) private readonly logger: ILogger,
    @inject(FS) private readonly fs: FsPromises,
  ) {}

  /**
   * Validates the path and returns an absolute path to the Node binary to run.
   */
  public async resolveAndValidate(
    env: EnvironmentVars,
    executable = 'node',
    explicitVersion?: number,
  ): Promise<NodeBinary> {
    const location = await this.resolveBinaryLocation(executable, env);
    this.logger.info(LogTag.RuntimeLaunch, 'Using binary at', { location, executable });
    if (!location) {
      throw new ProtocolError(
        cannotFindNodeBinary(
          executable,
          localize('runtime.node.notfound.enoent', 'path does not exist'),
        ),
      );
    }

    if (explicitVersion) {
      return new NodeBinary(location, new Semver(12, 0, 0));
    }

    // If the runtime executable doesn't look like Node.js (could be a shell
    // script that boots Node by itself, for instance) try to find Node itself
    // on the path as a fallback.
    const exeInfo = exeRe.exec(basename(location).toLowerCase());
    if (!exeInfo) {
      try {
        const realBinary = await this.resolveAndValidate(env, 'node');
        return new NodeBinary(location, realBinary.version);
      } catch (e) {
        // if we verified it's outdated, still throw the error. If it's not
        // found, at least try to run it since the package manager exists.
        if ((e as ProtocolError).cause.id === ErrorCodes.NodeBinaryOutOfDate) {
          throw e;
        }

        return new NodeBinary(location, undefined);
      }
    }

    // Seems like we can't get stdout from Node installed in snap, see:
    // https://github.com/microsoft/vscode/issues/102355#issuecomment-657707702
    if (location.startsWith('/snap/')) {
      return new NodeBinary(location, undefined);
    }

    const knownGood = this.knownGoodMappings.get(location);
    if (knownGood) {
      return knownGood;
    }

    // match the "12" in "v12.34.56"
    const versionText = await this.getVersionText(location);
    this.logger.info(LogTag.RuntimeLaunch, 'Discovered version', { version: versionText.trim() });

    const majorVersionMatch = /v([0-9]+)\.([0-9]+)\.([0-9]+)/.exec(versionText);
    if (!majorVersionMatch) {
      throw new ProtocolError(nodeBinaryOutOfDate(versionText.trim(), location));
    }

    const [, major, minor, patch] = majorVersionMatch.map(Number);
    let version = new Semver(major, minor, patch);

    // remap the node version bundled if we're running electron
    if (exeInfo[1] === 'electron') {
      const nodeVersion = await this.resolveAndValidate(env);
      version = Semver.min(
        electronNodeVersion.get(version.major) ?? assumedVersion,
        nodeVersion.version ?? assumedVersion,
      );
    }

    if (version.lt(minimumVersion)) {
      throw new ProtocolError(nodeBinaryOutOfDate(versionText.trim(), location));
    }

    const entry = new NodeBinary(location, version);
    this.knownGoodMappings.set(location, entry);
    return entry;
  }

  public async resolveBinaryLocation(executable: string, env: EnvironmentVars) {
    return executable && isAbsolute(executable)
      ? await findExecutable(this.fs, executable, env)
      : await findInPath(this.fs, executable, env.value);
  }

  public async getVersionText(binary: string) {
    try {
      const { stdout } = await spawnAsync(binary, ['--version'], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
      });
      return stdout;
    } catch (e) {
      throw new ProtocolError(
        cannotFindNodeBinary(
          binary,
          localize('runtime.node.notfound.spawnErr', 'error getting version: {0}', e.message),
        ),
      );
    }
  }
}
