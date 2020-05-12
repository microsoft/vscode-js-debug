/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { ITerminalLaunchConfiguration, AnyLaunchConfiguration } from '../../configuration';
import * as vscode from 'vscode';
import * as path from 'path';
import { StubProgram } from './program';
import { injectable, inject } from 'inversify';
import { IRunData, NodeLauncherBase, IProcessTelemetry } from './nodeLauncherBase';
import { DebugType } from '../../common/contributionUtils';
import { IBootloaderEnvironment, IAutoAttachInfo } from './bootloader/environment';
import { spawnWatchdog, bootloaderDefaultPath } from './watchdogSpawn';
import { ITerminalLauncherLike } from './terminalNodeLauncher';
import { ITarget } from '../targets';
import { ExtensionContext, FsPromises, FS } from '../../ioc-extras';
import { INodeBinaryProvider, NodeBinaryProvider } from './nodeBinaryProvider';
import { ILogger } from '../../common/logging';
import { canAccess } from '../../common/fsUtils';

const deferredSuffix = '.deferred';

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
  ) {
    super(pathProvider, logger);
  }

  /**
   * Gets the address of the socket server that children must use to connect.
   */
  public get deferredSocketName() {
    return this.extensionContext.environmentVariableCollection.get('NODE_INSPECTOR_IPC')?.value;
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
    const variables = this.extensionContext.environmentVariableCollection;
    if (!variables.get('NODE_INSPECTOR_DEFERRED_MODE')) {
      const useSpaces = await this.canUseSpacesInBootloaderPath(runData.params);
      const debugVars = (await this.resolveEnvironment(runData, useSpaces)).defined() as Required<
        IBootloaderEnvironment
      >;
      debugVars.NODE_INSPECTOR_DEFERRED_MODE = 'true';
      debugVars.NODE_INSPECTOR_IPC = debugVars.NODE_INSPECTOR_IPC + deferredSuffix;

      variables.persistent = true;
      for (const [key, value] of Object.entries(debugVars)) {
        variables.replace(key, value);
      }
    }

    this.program = new StubProgram();
    this.program.stopped.then(data => this.onProgramTerminated(data));
  }

  /**
   * Stores the bootloader in the storage path so that it doesn't change
   * location between the extension version updating.
   * @override
   */
  protected async getBootloaderFile(
    cwd: string | undefined,
    canUseSpacesInBootloaderPath: boolean,
  ) {
    // Use the local bootloader in development mode for easier iteration
    if (this.extensionContext.extensionMode !== vscode.ExtensionMode.Release) {
      return super.getBootloaderFile(cwd, canUseSpacesInBootloaderPath);
    }

    const storagePath =
      this.extensionContext.storagePath || this.extensionContext.globalStoragePath;
    if (!canUseSpacesInBootloaderPath && storagePath.includes(' ')) {
      return super.getBootloaderFile(cwd, canUseSpacesInBootloaderPath);
    }

    const bootloaderPath = path.join(storagePath, 'bootloader.js');
    if (!(await canAccess(this.fs, bootloaderPath))) {
      try {
        await this.fs.mkdir(storagePath);
      } catch {
        // already exists, most likely
      }

      await this.fs.copyFile(bootloaderDefaultPath, bootloaderPath);
    }

    return { path: bootloaderPath, dispose: () => undefined };
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
    const binary = await this.resolveNodePath(this.run.params);
    const wd = spawnWatchdog(binary.path, {
      ...data,
      ipcAddress: this.run.serverAddress, // may be outdated from a previous set of vars
    });

    wd.on('exit', () => this.telemetryItems.delete(pid));
  }

  public static clearVariables(context: vscode.ExtensionContext) {
    context.environmentVariableCollection.clear();
  }
}
