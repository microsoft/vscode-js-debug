/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { ITerminalLaunchConfiguration, AnyLaunchConfiguration } from '../../configuration';
import * as vscode from 'vscode';
import { StubProgram } from './program';
import { injectable } from 'inversify';
import { IRunData, NodeLauncherBase, IProcessTelemetry } from './nodeLauncherBase';
import { DebugType } from '../../common/contributionUtils';
import { IBootloaderEnvironment, IAutoAttachInfo } from './bootloader/environment';
import { spawnWatchdog } from './watchdogSpawn';
import { ITerminalLauncherLike } from './terminalNodeLauncher';
import { ITarget } from '../targets';

const deferredSuffix = '.deferred';

/**
 * A special launcher whose launchProgram is a no-op. Used in attach attachment
 * to create the 'server'.
 */
@injectable()
export class AutoAttachLauncher extends NodeLauncherBase<ITerminalLaunchConfiguration>
  implements ITerminalLauncherLike {
  private telemetryItems = new Map<number, IProcessTelemetry>();

  /**
   * Gets the address of the socket server that children must use to connect.
   */
  public get deferredSocketName() {
    return vscode.window.getEnvironmentVariableCollection(true).get('NODE_INSPECTOR_IPC')?.value;
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
    const variables = vscode.window.getEnvironmentVariableCollection(true);
    if (!variables.get('NODE_INSPECTOR_DEFERRED_MODE')) {
      const debugVars = this.resolveEnvironment(runData).defined() as Required<
        IBootloaderEnvironment
      >;
      debugVars.NODE_INSPECTOR_DEFERRED_MODE = 'true';
      debugVars.NODE_INSPECTOR_IPC = debugVars.NODE_INSPECTOR_IPC + deferredSuffix;
      for (const [key, value] of Object.entries(debugVars)) {
        variables.replace(key, value);
      }
    }

    this.program = new StubProgram();
    this.program.stopped.then(data => this.onProgramTerminated(data));
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
    const wd = spawnWatchdog(await this.resolveNodePath(this.run.params), {
      ...data,
      ipcAddress: this.run.serverAddress, // may be outdated from a previous set of vars
    });

    wd.on('exit', () => this.telemetryItems.delete(pid));
  }

  public static clearVariables() {
    const variables = vscode.window.getEnvironmentVariableCollection();
    variables.clear();
  }
}
