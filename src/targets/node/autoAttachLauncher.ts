/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { inject, injectable } from 'inversify';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  AutoAttachMode,
  Configuration,
  DebugType,
  readConfig,
} from '../../common/contributionUtils';
import { IFsUtils, LocalFsUtils } from '../../common/fsUtils';
import { ILogger } from '../../common/logging';
import { forceForwardSlashes } from '../../common/pathUtils';
import { AnyLaunchConfiguration, ITerminalLaunchConfiguration } from '../../configuration';
import { ErrorCodes } from '../../dap/errors';
import { ProtocolError } from '../../dap/protocolError';
import { ExtensionContext, FS, FsPromises } from '../../ioc-extras';
import { ITarget } from '../targets';
import {
  BootloaderEnvironment,
  IAutoAttachInfo,
  IBootloaderEnvironment,
  variableDelimiter,
} from './bootloader/environment';
import { bootloaderDefaultPath, watchdogPath } from './bundlePaths';
import {
  Capability,
  INodeBinaryProvider,
  NodeBinary,
  NodeBinaryProvider,
} from './nodeBinaryProvider';
import { IProcessTelemetry, IRunData, NodeLauncherBase } from './nodeLauncherBase';
import { StubProgram } from './program';
import { ITerminalLauncherLike } from './terminalNodeLauncher';
import { WatchDog } from './watchdogSpawn';

/**
 * A special launcher whose launchProgram is a no-op. Used in attach attachment
 * to create the 'server'.
 */
@injectable()
export class AutoAttachLauncher extends NodeLauncherBase<ITerminalLaunchConfiguration>
  implements ITerminalLauncherLike {
  private telemetryItems = new Map<number, IProcessTelemetry>();

  constructor(
    @inject(INodeBinaryProvider) pathProvider: NodeBinaryProvider,
    @inject(ILogger) logger: ILogger,
    @inject(ExtensionContext) private readonly extensionContext: vscode.ExtensionContext,
    @inject(FS) private readonly fs: FsPromises,
    @inject(IFsUtils) fsUtils: LocalFsUtils,
  ) {
    super(pathProvider, logger, fsUtils);
  }

  /**
   * Gets the address of the socket server that children must use to connect.
   */
  public get deferredSocketName() {
    const options = this.extensionContext.environmentVariableCollection.get(
      'VSCODE_INSPECTOR_OPTIONS',
    );

    if (!options) {
      return;
    }

    const env = new BootloaderEnvironment({ VSCODE_INSPECTOR_OPTIONS: options.value });
    return env.inspectorOptions?.inspectorIpc;
  }

  /**
   * @inheritdoc
   */
  public getProcessTelemetry(target: ITarget) {
    return Promise.resolve(this.telemetryItems.get(Number(target.id())));
  }

  /**
   * @inheritdoc
   */
  protected resolveParams(
    params: AnyLaunchConfiguration,
  ): ITerminalLaunchConfiguration | undefined {
    if (params.type === DebugType.Terminal && params.request === 'launch') {
      return params;
    }

    return undefined;
  }

  /**
   * Launches the program.
   */
  protected async launchProgram(runData: IRunData<ITerminalLaunchConfiguration>): Promise<void> {
    await this.applyInspectorOptions(this.extensionContext.environmentVariableCollection, runData);
    this.program = new StubProgram();
    this.program.stopped.then(data => this.onProgramTerminated(data));
  }

  /**
   * (Re-)applies the current variables to the terminals if a run is
   * currently happening.
   */
  public async refreshVariables() {
    if (this.run) {
      await this.applyInspectorOptions(
        this.extensionContext.environmentVariableCollection,
        this.run,
      );
    }
  }

  private async applyInspectorOptions(
    variables: vscode.EnvironmentVariableCollection,
    runData: IRunData<ITerminalLaunchConfiguration>,
  ) {
    let binary: NodeBinary;
    try {
      binary = await this.resolveNodePath(runData.params);
    } catch (e) {
      if (e instanceof ProtocolError && e.cause.id === ErrorCodes.CannotFindNodeBinary) {
        binary = new NodeBinary('node', undefined);
      } else {
        throw e;
      }
    }

    const autoAttachMode = readConfig(vscode.workspace, Configuration.AutoAttachMode);
    const debugVars = await this.resolveEnvironment(runData, binary, {
      deferredMode: true,
      inspectorIpc: this.deferredSocketName ?? runData.serverAddress + '.deferred',
      autoAttachMode,
      aaPatterns: autoAttachMode === AutoAttachMode.Smart ? this.readSmartPatterns() : undefined,
    });

    const bootloaderEnv = (debugVars.defined() as unknown) as IBootloaderEnvironment;

    variables.persistent = true;
    variables.prepend('NODE_OPTIONS', bootloaderEnv.NODE_OPTIONS + ' ');
    variables.append(
      'VSCODE_INSPECTOR_OPTIONS',
      variableDelimiter + bootloaderEnv.VSCODE_INSPECTOR_OPTIONS,
    );
  }

  private readSmartPatterns() {
    const configured = readConfig(vscode.workspace, Configuration.AutoAttachSmartPatterns);
    const allFolders = `{${vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath).join(',')}}`;
    return configured
      ?.map(c => c.replace('${workspaceFolder}', allFolders))
      .map(forceForwardSlashes);
  }

  /**
   * Stores the bootloader in the storage path so that it doesn't change
   * location between the extension version updating.
   * @override
   */
  protected async getBootloaderFile(cwd: string | undefined, binary: NodeBinary) {
    // Use the local bootloader in development mode for easier iteration
    // if (this.extensionContext.extensionMode === vscode.ExtensionMode.Development) {
    //   return super.getBootloaderFile(cwd, binary);
    // }

    const storagePath =
      this.extensionContext.storagePath || this.extensionContext.globalStoragePath;
    if (storagePath.includes(' ')) {
      if (!binary.isPreciselyKnown) {
        throw new AutoAttachPreconditionFailed(
          'We did not find `node` on your PATH, so we cannot enable auto-attach in your environment',
          'https://github.com/microsoft/vscode-js-debug/issues/708',
        );
      }

      if (!binary.has(Capability.UseSpacesInRequirePath)) {
        throw new AutoAttachPreconditionFailed(
          `The \`node\` version on your PATH is too old (${binary.version?.major}), so we cannot enable auto-attach in your environment`,
          'https://github.com/microsoft/vscode-js-debug/issues/708',
        );
      }
    }

    const bootloaderPath = path.join(storagePath, 'bootloader.js');
    try {
      await this.fs.mkdir(storagePath);
    } catch {
      // already exists, most likely
    }

    await Promise.all([
      this.fs.copyFile(bootloaderDefaultPath, bootloaderPath),
      this.fs.copyFile(watchdogPath, path.join(storagePath, 'watchdog.bundle.js')),
    ]);

    const p = forceForwardSlashes(bootloaderPath);
    return { interpolatedPath: p.includes(' ') ? `"${p}"` : p, dispose: () => undefined };
  }

  /**
   * Spawns a watchdog for the child process to attach back to this server.
   */
  public async spawnForChild(data: IAutoAttachInfo) {
    if (!this.run) {
      return;
    }

    const pid = Number(data.pid ?? '0');
    this.telemetryItems.set(pid, data.telemetry);
    const wd = await WatchDog.attach({
      ...data,
      ipcAddress: this.run.serverAddress, // may be outdated from a previous set of vars
    });
    wd.onEnd(() => this.telemetryItems.delete(pid));
  }

  public static clearVariables(context: vscode.ExtensionContext) {
    context.environmentVariableCollection.clear();
  }
}

export class AutoAttachPreconditionFailed extends Error {
  constructor(message: string, public readonly helpLink?: string) {
    super(message);
  }
}
