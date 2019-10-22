// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter, Event, Disposable } from '../../common/events';
import Cdp from '../../cdp/api';
import Connection from '../../cdp/connection';
import { PipeTransport } from '../../cdp/transport';
import { Launcher, Target, LaunchResult, ILaunchContext } from '../../targets/targets';
import { execFileSync } from 'child_process';
import { INodeLaunchConfiguration, AnyLaunchConfiguration } from '../../configuration';
import { Contributions } from '../../common/contributionUtils';
import { EnvironmentVars } from '../../common/environmentVars';
import { NodeTarget } from './nodeTarget';
import { NodeSourcePathResolver } from './nodeSourcePathResolver';

/**
 * Interface that handles booting a program to debug.
 */
export interface IProgramLauncher extends Disposable {
  /**
   * Executs the program.
   */
  launchProgram(args: INodeLaunchConfiguration, context: ILaunchContext): Promise<void>;

  /**
   * Stops any executing program.
   */
  stopProgram(): void;
  /**
   * Event that fires when the program stops.
   */
  onProgramStopped: Event<void>;
}

let counter = 0;

export class NodeLauncher implements Launcher {
  private _server: net.Server | undefined;
  private _connections: Connection[] = [];
  private _launchParams?: INodeLaunchConfiguration;
  private _pipe: string | undefined;
  private _isRestarting = false;
  _targets = new Map<string, NodeTarget>();
  _pathResolver?: NodeSourcePathResolver;
  public context?: ILaunchContext;
  private _onTerminatedEmitter = new EventEmitter<void>();
  readonly onTerminated = this._onTerminatedEmitter.event;
  _onTargetListChangedEmitter = new EventEmitter<void>();
  readonly onTargetListChanged = this._onTargetListChangedEmitter.event;

  constructor(private readonly _programLauncher: IProgramLauncher) {
    this._programLauncher.onProgramStopped(() => {
      if (!this._isRestarting) {
        this._stopServer();
        this._onTerminatedEmitter.fire();
      }
    });
  }

  public async launch(params: AnyLaunchConfiguration, context: ILaunchContext): Promise<LaunchResult> {
    if (
      params.type === Contributions.ChromeDebugType &&
      params.request === 'launch' &&
      params.server
    ) {
      params = params.server;
    } else if (params.type !== Contributions.NodeDebugType || params.request !== 'launch') {
      return { blockSessionTermination: false };
    }

    this._launchParams = params;
    this._pathResolver = new NodeSourcePathResolver({
      basePath: this._launchParams.cwd,
      sourceMapOverrides: this._launchParams.sourceMapPathOverrides,
    });
    this.context = context;
    await this._startServer(this._launchParams);
    this.launchProgram();
    return { blockSessionTermination: true };
  }

  public async terminate(): Promise<void> {
    this._programLauncher.stopProgram();
    await this._stopServer();
  }

  public async disconnect(): Promise<void> {
    this._programLauncher.stopProgram();
    await this._stopServer();
  }

  public async restart(): Promise<void> {
    if (!this._launchParams) {
      return;
    }

    // Dispose all the connections - Node would not exit child processes otherwise.
    this._isRestarting = true;
    this._stopServer();
    await this._startServer(this._launchParams);
    this.launchProgram();
    this._isRestarting = false;
  }

  private launchProgram() {
    this._programLauncher.stopProgram();

    if (!this._launchParams) {
      return;
    }

    const bootloaderJS = path.join(__dirname, 'bootloader.js');
    const env = EnvironmentVars.merge(process.env, this._launchParams.env);

    this._programLauncher.launchProgram({
      ...this._launchParams,
      env: env.merge({
        NODE_INSPECTOR_IPC: this._pipe || null,
        NODE_INSPECTOR_PPID: '',
        // todo: look at reimplementing the filter
        // NODE_INSPECTOR_WAIT_FOR_DEBUGGER: this._launchParams!.nodeFilter || '',
        NODE_INSPECTOR_WAIT_FOR_DEBUGGER: '',
        // Require our bootloader first, to run it before any other bootloader
        // we could have injected in the parent process.
        NODE_OPTIONS: `--require ${bootloaderJS} ${env.lookup('NODE_OPTIONS') || ''}`,
        // Supply some node executable for running top-level watchdog in Electron
        // environments. Bootloader will replace this with actual node executable used if any.
        NODE_INSPECTOR_EXEC_PATH: findNode() || '',
        VSCODE_DEBUGGER_ONLY_ENTRYPOINT: this._launchParams.autoAttachChildProcesses ? 'false' : 'true',
        ELECTRON_RUN_AS_NODE: null,
      }).value,
    }, this.context!);
  }

  private _startServer(args: INodeLaunchConfiguration) {
    const pipePrefix = process.platform === 'win32' ? '\\\\.\\pipe\\' : os.tmpdir();
    this._pipe = path.join(pipePrefix, `node-cdp.${process.pid}-${++counter}.sock`);
    this._server = net
      .createServer(socket => {
        this._startSession(socket, args);
      })
      .listen(this._pipe);
  }

  private _stopServer() {
    if (this._server) this._server.close();
    this._server = undefined;
    this._connections.forEach(c => c.close());
    this._connections = [];
  }

  private async _startSession(socket: net.Socket, args: INodeLaunchConfiguration) {
    const connection = new Connection(new PipeTransport(socket));
    this._connections.push(connection);
    const cdp = connection.rootSession();
    const { targetInfo } = await new Promise<Cdp.Target.TargetCreatedEvent>(f =>
      cdp.Target.on('targetCreated', f),
    );
    new NodeTarget(this, connection, cdp, targetInfo, args);
    this._onTargetListChangedEmitter.fire();
  }

  public targetList(): Target[] {
    return Array.from(this._targets.values());
  }

  public dispose() {
    this._stopServer();
  }
}


function findNode(): string | undefined {
  // TODO: implement this for Windows.
  if (process.platform !== 'linux' && process.platform !== 'darwin') return;
  try {
    return execFileSync('which', ['node'], { stdio: 'pipe' })
      .toString()
      .split(/\r?\n/)[0];
  } catch (e) {}
}
