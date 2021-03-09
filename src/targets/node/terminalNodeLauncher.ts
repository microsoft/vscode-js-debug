/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { randomBytes } from 'crypto';
import { inject, injectable } from 'inversify';
import { tmpdir } from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { DebugType } from '../../common/contributionUtils';
import { EventEmitter } from '../../common/events';
import { ILogger } from '../../common/logging';
import { AnyLaunchConfiguration, ITerminalLaunchConfiguration } from '../../configuration';
import { ErrorCodes } from '../../dap/errors';
import { ProtocolError } from '../../dap/protocolError';
import { FS, FsPromises } from '../../ioc-extras';
import { ISourcePathResolverFactory } from '../sourcePathResolverFactory';
import { IStopMetadata, ITarget } from '../targets';
import {
  hideDebugInfoFromConsole,
  INodeBinaryProvider,
  NodeBinary,
  NodeBinaryProvider,
} from './nodeBinaryProvider';
import { IProcessTelemetry, IRunData, NodeLauncherBase } from './nodeLauncherBase';
import { IProgram } from './program';

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
    // send ctrl+c to sigint any running processs (vscode/#108289)
    this.terminal.sendText('\x03');
    // and then destroy it on the next event loop tick
    setTimeout(() => this.terminal.dispose(), 1);

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
    @inject(ISourcePathResolverFactory) pathResolverFactory: ISourcePathResolverFactory,
  ) {
    super(pathProvider, logger, pathResolverFactory);
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
      } else {
        binary = new NodeBinary('node', undefined);
      }
    }

    const env = await this.resolveEnvironment(runData, binary, {
      fileCallback: this.callbackFile,
    });

    const terminal = vscode.window.createTerminal({
      name: runData.params.name,
      cwd: runData.params.cwd,
      env: hideDebugInfoFromConsole(binary, env).defined(),
    });
    this.terminalCreatedEmitter.fire(terminal);

    terminal.show();
    const program = (this.program = new VSCodeTerminalProcess(terminal));

    if (runData.params.command) {
      terminal.sendText(runData.params.command, true);
    }

    program.stopped.then(result => {
      if (program === this.program) {
        this.onProgramTerminated(result);
      }
    });
  }

  /**
   * @inheritdoc
   */
  public dispose() {
    super.dispose();
    this.fs.unlink(this.callbackFile).catch(() => undefined);
  }
}
