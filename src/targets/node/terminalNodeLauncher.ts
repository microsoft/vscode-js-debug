/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { AnyLaunchConfiguration, ITerminalLaunchConfiguration } from '../../configuration';
import * as vscode from 'vscode';
import * as path from 'path';
import { DebugType } from '../../common/contributionUtils';
import { NodeLauncherBase, IRunData, IProcessTelemetry } from './nodeLauncherBase';
import { IProgram } from './program';
import { IStopMetadata, ITarget } from '../targets';
import { ProtocolError, ErrorCodes } from '../../dap/errors';
import { EventEmitter } from '../../common/events';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { injectable, inject } from 'inversify';
import { FS, FsPromises } from '../../ioc-extras';
import { INodeBinaryProvider, NodeBinaryProvider, NodeBinary } from './nodeBinaryProvider';
import { ILogger } from '../../common/logging';

class VSCodeTerminalProcess implements IProgram {
  public readonly stopped: Promise<IStopMetadata>;

  constructor(private readonly terminal: vscode.Terminal) {
    this.stopped = new Promise(resolve => {
      const disposable = vscode.window.onDidCloseTerminal(t => {
        if (t === terminal) {
          resolve({ code: 0, killed: true });
          disposable.dispose();
        }
      });
    });
  }

  public gotTelemetery() {
    // no-op
  }

  public stop() {
    this.terminal.dispose();
    return this.stopped;
  }
}

export interface ITerminalLauncherLike extends NodeLauncherBase<ITerminalLaunchConfiguration> {
  /**
   * Gets telemetry of the last-started process.
   */
  getProcessTelemetry(target: ITarget): Promise<IProcessTelemetry | undefined>;
}

/**
 * A special launcher which only opens a vscode terminal. Used for the
 * "debugger terminal" in the extension.
 */
@injectable()
export class TerminalNodeLauncher extends NodeLauncherBase<ITerminalLaunchConfiguration> {
  private terminalCreatedEmitter = new EventEmitter<vscode.Terminal>();
  protected callbackFile = path.join(
    tmpdir(),
    `node-debug-callback-${randomBytes(8).toString('hex')}`,
  );

  public readonly onTerminalCreated = this.terminalCreatedEmitter.event;

  constructor(
    @inject(INodeBinaryProvider) pathProvider: NodeBinaryProvider,
    @inject(ILogger) logger: ILogger,
    @inject(FS) private readonly fs: FsPromises,
  ) {
    super(pathProvider, logger);
  }

  /**
   * Gets telemetry of the last-started process.
   */
  public async getProcessTelemetry() {
    try {
      return JSON.parse(await this.fs.readFile(this.callbackFile, 'utf-8')) as IProcessTelemetry;
    } catch {
      return undefined;
    }
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

    if (params.type === DebugType.Chrome && params.server && 'command' in params.server) {
      return params.server;
    }

    return undefined;
  }

  /**
   * Launches the program.
   */
  protected async launchProgram(runData: IRunData<ITerminalLaunchConfiguration>): Promise<void> {
    // Make sure that, if we can _find_ a in their path, it's the right
    // version so that we don't mysteriously never connect fail.
    let binary: NodeBinary | undefined;
    try {
      binary = await this.resolveNodePath(runData.params);
    } catch (err) {
      if (err instanceof ProtocolError && err.cause.id === ErrorCodes.NodeBinaryOutOfDate) {
        throw err;
      }
    }

    const env = await this.resolveEnvironment(runData, binary?.canUseSpacesInRequirePath ?? true, {
      fileCallback: this.callbackFile,
    });

    const terminal = vscode.window.createTerminal({
      name: runData.params.name,
      cwd: runData.params.cwd,
      env: env.defined(),
    });
    this.terminalCreatedEmitter.fire(terminal);

    terminal.show();
    this.program = new VSCodeTerminalProcess(terminal);

    if (runData.params.command) {
      terminal.sendText(runData.params.command, true);
    }
  }

  /**
   * @inheritdoc
   */
  public dispose() {
    super.dispose();
    this.fs.unlink(this.callbackFile).catch(() => undefined);
  }
}
