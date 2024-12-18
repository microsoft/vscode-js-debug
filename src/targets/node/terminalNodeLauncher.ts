/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { IDebugTerminalOptionsProvider } from '@vscode/js-debug';
import { randomBytes } from 'crypto';
import { inject, injectable, optional } from 'inversify';
import { tmpdir } from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { IPortLeaseTracker } from '../../adapter/portLeaseTracker';
import { DebugType } from '../../common/contributionUtils';
import { EventEmitter } from '../../common/events';
import { ILogger } from '../../common/logging';
import { delay } from '../../common/promiseUtil';
import { ITerminalLinkProvider } from '../../common/terminalLinkProvider';
import { AnyLaunchConfiguration, ITerminalLaunchConfiguration } from '../../configuration';
import { ErrorCodes } from '../../dap/errors';
import { ProtocolError } from '../../dap/protocolError';
import { FS, FsPromises, IDebugTerminalOptionsProviders } from '../../ioc-extras';
import { ISourcePathResolverFactory } from '../sourcePathResolverFactory';
import { IStopMetadata, ITarget } from '../targets';
import { hideDebugInfoFromConsole, INodeBinaryProvider, NodeBinary } from './nodeBinaryProvider';
import { IProcessTelemetry, IRunData, NodeLauncherBase } from './nodeLauncherBase';
import { IProgram } from './program';

const SHELL_INTEGRATION_TIMEOUT = 1000;
const SHELL_PROCESS_ID_TIMEOUT = 1000;

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
    @inject(INodeBinaryProvider) pathProvider: INodeBinaryProvider,
    @inject(ILogger) logger: ILogger,
    @inject(FS) private readonly fs: FsPromises,
    @inject(ISourcePathResolverFactory) pathResolverFactory: ISourcePathResolverFactory,
    @inject(IPortLeaseTracker) portLeaseTracker: IPortLeaseTracker,
    @inject(IDebugTerminalOptionsProviders) private readonly optionsProviders: ReadonlySet<
      IDebugTerminalOptionsProvider
    >,
    @optional()
    @inject(ITerminalLinkProvider)
    private readonly terminalLinkProvider: ITerminalLinkProvider | undefined,
  ) {
    super(pathProvider, logger, portLeaseTracker, pathResolverFactory);
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

    let options: vscode.TerminalOptions = {
      name: runData.params.name,
      cwd: runData.params.cwd,
      iconPath: new vscode.ThemeIcon('debug'),
      env: hideDebugInfoFromConsole(binary, env).defined(),
      isTransient: true,
    };

    for (const provider of this.optionsProviders) {
      const result = await provider.provideTerminalOptions(options);
      if (result) {
        options = result;
      }
    }

    const terminal = await this.createTerminal(options);
    this.terminalLinkProvider?.enableHandlingInTerminal(terminal);
    this.terminalCreatedEmitter.fire(terminal);

    terminal.show();
    const program = (this.program = new VSCodeTerminalProcess(terminal));

    if (runData.params.command) {
      await this.writeCommand(terminal, runData.params.command);
    }

    program.stopped.then(result => {
      if (program === this.program) {
        this.onProgramTerminated(result);
      }
    });
  }

  private async writeCommand(terminal: vscode.Terminal, command: string) {
    // Wait for shell integration if we expect it to be available
    if (!terminal.shellIntegration) {
      let listener: vscode.Disposable;
      await Promise.race([
        delay(SHELL_INTEGRATION_TIMEOUT),
        new Promise<void>(resolve => {
          listener = vscode.window.onDidChangeTerminalShellIntegration(e => {
            if (e.terminal === terminal && e.shellIntegration) {
              resolve();
            }
          });
        }),
      ]);

      listener!.dispose();
    }

    if (terminal.shellIntegration) {
      terminal.shellIntegration.executeCommand(command);
    } else {
      // Add wait for #1642
      // "There's a known issue that processId can not resolve... to be safe could you have a race timeout"
      await Promise.race([terminal.processId, delay(SHELL_PROCESS_ID_TIMEOUT)]);
      terminal.sendText(command, true);
    }
  }

  /**
   * Creates a terminal with the requested options.
   */
  protected createTerminal(options: vscode.TerminalOptions) {
    return Promise.resolve(vscode.window.createTerminal(options));
  }

  /**
   * @inheritdoc
   */
  public dispose() {
    super.dispose();
    this.fs.unlink(this.callbackFile).catch(() => undefined);
  }
}
