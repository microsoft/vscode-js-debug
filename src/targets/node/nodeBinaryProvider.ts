/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import { inject, injectable, optional } from 'inversify';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'path';
import type * as vscodeType from 'vscode';
import { EnvironmentVars } from '../../common/environmentVars';
import { existsInjected } from '../../common/fsUtils';
import { ILogger, LogTag } from '../../common/logging';
import { findExecutable, findInPath } from '../../common/pathUtils';
import { spawnAsync } from '../../common/processUtils';
import { Semver } from '../../common/semver';
import { getNormalizedBinaryName, nearestDirectoryWhere } from '../../common/urlUtils';
import {
  cannotFindNodeBinary,
  cwdDoesNotExist,
  ErrorCodes,
  isErrorOfType,
  nodeBinaryOutOfDate,
} from '../../dap/errors';
import { ProtocolError } from '../../dap/protocolError';
import { FS, FsPromises, VSCodeApi } from '../../ioc-extras';
import { IPackageJsonProvider } from './packageJsonProvider';

export const INodeBinaryProvider = Symbol('INodeBinaryProvider');

export const enum Capability {
  UseSpacesInRequirePath,
  UseInspectPublishUid,
  UseExperimentalNetworking,
}

/**
 * If the Node binary supports it, adds an option to the NODE_OPTIONS that
 * prevents spewing extra debug info to the console.
 * @see https://github.com/microsoft/vscode-js-debug/issues/558
 */
export function hideDebugInfoFromConsole(binary: NodeBinary, env: EnvironmentVars) {
  return binary.has(Capability.UseInspectPublishUid)
    ? env.addNodeOption('--inspect-publish-uid=http')
    : env;
}

const packageManagers: ReadonlySet<string> = new Set(['npm', 'yarn', 'pnpm', 'tnpm', 'cnpm']);

export const isPackageManager = (exe: string) => packageManagers.has(basename(exe, extname(exe)));

/**
 * Detects an "npm run"-style invokation, and if found gets the script that the
 * user intends to run.
 */
export const getRunScript = (
  runtimeExecutable: string | null,
  runtimeArgs: ReadonlyArray<string>,
) => {
  if (!runtimeExecutable || !isPackageManager(runtimeExecutable)) {
    return;
  }

  return runtimeArgs.find(a => !a.startsWith('-') && a !== 'run' && a !== 'run-script');
};

const assumedVersion = new Semver(12, 0, 0);
const minimumVersion = new Semver(8, 0, 0);

export interface IWarningMessage {
  inclusiveMin: Semver;
  inclusiveMax: Semver;
  message: string;
}

const warningMessages: ReadonlyArray<IWarningMessage> = [
  {
    inclusiveMin: new Semver(16, 0, 0),
    inclusiveMax: new Semver(16, 3, 99),
    message: l10n.t(
      'Some breakpoints might not work in your version of Node.js. We recommend upgrading for the latest bug, performance, and security fixes. Details: https://aka.ms/AAcsvqm',
    ),
  },
  {
    inclusiveMin: new Semver(7, 0, 0),
    inclusiveMax: new Semver(8, 99, 99),
    message: l10n.t(
      "You're running an outdated version of Node.js. We recommend upgrading for the latest bug, performance, and security fixes.",
    ),
  },
];

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

  /**
   * Gets a warning message for users of the binary.
   */
  public get warning() {
    if (!this.version) {
      return;
    }

    for (const message of warningMessages) {
      if (message.inclusiveMax.gte(this.version) && message.inclusiveMin.lte(this.version)) {
        return message;
      }
    }

    return undefined;
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

    // todo@connor4312: the current API we get in Node.js is pretty tiny and
    // I don't want to ship it by default in its current version, ref
    // https://github.com/nodejs/node/pull/53593#issuecomment-2276367389
    // Users can still turn it on by setting `experimentalNetworking: on`.
    // if (version.gte(new Semver(22, 6, 0)) && version.lt(new Semver(24, 0, 0))) {
    //   this.capabilities.add(Capability.UseExperimentalNetworking);
    // }
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

export class NodeBinaryOutOfDateError extends ProtocolError {
  constructor(public readonly version: string | Semver, public readonly location: string) {
    super(nodeBinaryOutOfDate(version.toString(), location));
  }
}

const nodeOrElectronBinaries = ['node', 'node64', 'electron'];

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

export interface INodeBinaryProvider {
  /**
   * Validates the path and returns an absolute path to the Node binary to run.
   * @param env The environment variables to use to resolve the node binary.
   * @param executable An explicit executable path to resolve, will bypass
   * path-based detection if given.
   * @param explicitVersion An explicit Node.js version to use, will bypass
   * version checking on the binary ig given.
   */
  resolveAndValidate(
    env: EnvironmentVars,
    executable?: string,
    explicitVersion?: number,
    cwd?: string,
  ): Promise<NodeBinary>;
}

/**
 * Utility that resolves a path to Node.js and validates
 * it's a debuggable version./
 */
@injectable()
export class NodeBinaryProvider implements INodeBinaryProvider {
  /**
   * A set of binary paths we know are good and which can skip additional
   * validation. We don't store bad mappings, because a user might reinstall
   * or upgrade node in-place after we tell them it's outdated.
   */
  private readonly knownGoodMappings = new Map<string, NodeBinary>();

  constructor(
    @inject(ILogger) private readonly logger: ILogger,
    @inject(FS) private readonly fs: FsPromises,
    @inject(IPackageJsonProvider) private readonly packageJson: IPackageJsonProvider,
  ) {}

  /**
   * Validates the path and returns an absolute path to the Node binary to run.
   */
  public async resolveAndValidate(
    env: EnvironmentVars,
    executable = 'node',
    explicitVersion?: number,
    cwd?: string,
  ): Promise<NodeBinary> {
    try {
      return await this.resolveAndValidateInner(env, executable, explicitVersion, cwd);
    } catch (e) {
      if (!(e instanceof NodeBinaryOutOfDateError)) {
        throw e;
      }

      if (await this.shouldTryDebuggingAnyway(e)) {
        return new NodeBinary(e.location, e.version instanceof Semver ? e.version : undefined);
      }

      throw e;
    }
  }

  /**
   * Gets whether we should continue to try to debug even if we saw an outdated
   * Node.js version.
   */
  protected shouldTryDebuggingAnyway(_outatedReason: NodeBinaryOutOfDateError) {
    return Promise.resolve(false);
  }

  private async resolveNodeModulesLocation(
    env: EnvironmentVars,
    executable: string,
    cwd: string | undefined,
  ) {
    if (!cwd || isAbsolute(executable) || !isAbsolute(cwd)) {
      return undefined;
    }

    return nearestDirectoryWhere(
      cwd,
      dir => findExecutable(this.fs, join(dir, 'node_modules', '.bin', executable), env),
    );
  }

  private async resolveAndValidateInner(
    env: EnvironmentVars,
    executable: string,
    explicitVersion: number | undefined,
    cwd: string | undefined,
  ): Promise<NodeBinary> {
    let location = await this.resolveBinaryLocation(executable, env);
    if (!location) {
      location = await this.resolveNodeModulesLocation(env, executable, cwd);
    }

    this.logger.info(LogTag.RuntimeLaunch, 'Using binary at', { location, executable });
    if (!location) {
      throw new ProtocolError(cannotFindNodeBinary(executable, l10n.t('path does not exist')));
    }

    if (explicitVersion) {
      return new NodeBinary(location, new Semver(explicitVersion, 0, 0));
    }

    // If the runtime executable doesn't look like Node.js (could be a shell
    // script that boots Node by itself, for instance) try to find Node itself
    // on the path as a fallback.
    const exeName = getNormalizedBinaryName(location);
    if (!nodeOrElectronBinaries.includes(exeName)) {
      if (isPackageManager(location)) {
        const packageJson = await this.packageJson.getPath();
        if (packageJson) {
          env = env.addToPath(resolve(dirname(packageJson), 'node_modules/.bin'), 'prepend');
        }
      }

      try {
        const realBinary = await this.resolveAndValidateInner(env, 'node', undefined, cwd);
        return new NodeBinary(location, realBinary.version);
      } catch (e) {
        // if we verified it's outdated, still throw the error. If it's not
        // found, at least try to run it since the package manager exists.
        if (isErrorOfType(e, ErrorCodes.NodeBinaryOutOfDate)) {
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
    const versionText = await this.getVersionText(location, cwd);

    // Handle other cases where Node.js is installed via snap, but not in `/span/`.
    // We just get empty output from it in that case.
    if (!versionText) {
      return new NodeBinary(location, undefined);
    }

    this.logger.info(LogTag.RuntimeLaunch, 'Discovered version', { version: versionText });

    const majorVersionMatch = /v([0-9]+)\.([0-9]+)\.([0-9]+)/.exec(versionText);
    if (!majorVersionMatch) {
      throw new NodeBinaryOutOfDateError(versionText, location);
    }

    const [, major, minor, patch] = majorVersionMatch.map(Number);
    let version = new Semver(major, minor, patch);

    // remap the node version bundled if we're running electron
    if (exeName === 'electron') {
      const nodeVersion = await this.resolveAndValidate(env);
      version = Semver.min(
        electronNodeVersion.get(version.major) ?? assumedVersion,
        nodeVersion.version ?? assumedVersion,
      );
    }

    if (version.lt(minimumVersion)) {
      throw new NodeBinaryOutOfDateError(version, location);
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

  public async getVersionText(binary: string, cwd: string | undefined) {
    try {
      const { stdout } = await spawnAsync(binary, ['--version'], {
        env: EnvironmentVars.processEnv().defined(),
        cwd,
      });
      return stdout.trim();
    } catch (e) {
      if (cwd && !(await existsInjected(this.fs, cwd))?.isDirectory()) {
        throw new ProtocolError(cwdDoesNotExist(cwd));
      }

      throw new ProtocolError(cannotFindNodeBinary(binary, e.message));
    }
  }
}

export class InteractiveNodeBinaryProvider extends NodeBinaryProvider {
  constructor(
    @inject(ILogger) logger: ILogger,
    @inject(FS) fs: FsPromises,
    @inject(IPackageJsonProvider) packageJson: IPackageJsonProvider,
    @optional() @inject(VSCodeApi) private readonly vscode: typeof vscodeType | undefined,
  ) {
    super(logger, fs, packageJson);
  }

  /**
   * @override
   */
  protected async shouldTryDebuggingAnyway({ message }: NodeBinaryOutOfDateError) {
    if (!this.vscode) {
      return false;
    }

    const yes = l10n.t('Yes');
    const response = await this.vscode.window.showErrorMessage(message, yes);

    return response === yes;
  }
}
