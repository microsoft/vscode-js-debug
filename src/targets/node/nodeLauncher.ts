// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { EventEmitter } from '../../common/events';
import Cdp from '../../cdp/api';
import Connection from '../../cdp/connection';
import { PipeTransport } from '../../cdp/transport';
import { Launcher, Target, LaunchResult, ILaunchContext, IStopMetadata } from '../../targets/targets';
import { execFileSync } from 'child_process';
import { INodeLaunchConfiguration, AnyLaunchConfiguration } from '../../configuration';
import { Contributions } from '../../common/contributionUtils';
import { EnvironmentVars } from '../../common/environmentVars';
import { NodeTarget } from './nodeTarget';
import { NodeSourcePathResolver } from './nodeSourcePathResolver';
import { IProgram } from './program';
import { ProtocolError, cannotLoadEnvironmentVars } from '../../dap/errors';
import { IProgramLauncher } from './processLauncher';
import { CallbackFile } from './callback-file';
import { RestartPolicyFactory } from './restartPolicy';
import { delay } from '../../common/promiseUtil';

/**
 * Telemetry received from the nested process.
 */
export interface IProcessTelemetry {
  /**
   * Target process ID.
   */
  processId: number;

  /**
   * Process node version.
   */
  nodeVersion: string;

  /**
   * CPU architecture.
   */
  architecture: string;
}

let counter = 0;

export class NodeLauncher implements Launcher {
  private _server: net.Server | undefined;
  private _connections: Connection[] = [];
  private _launchParams?: INodeLaunchConfiguration;
  private _pipe: string | undefined;
  _targets = new Map<string, NodeTarget>();
  _pathResolver?: NodeSourcePathResolver;
  public context?: ILaunchContext;
  private _onTerminatedEmitter = new EventEmitter<IStopMetadata>();
  readonly onTerminated = this._onTerminatedEmitter.event;
  _onTargetListChangedEmitter = new EventEmitter<void>();
  readonly onTargetListChanged = this._onTargetListChangedEmitter.event;

  /**
   * The currently running program. Set to undefined if there's no process
   * running.
   */
  private program?: IProgram;

  constructor(
    private readonly launchers: ReadonlyArray<IProgramLauncher>,
    private readonly restarters = new RestartPolicyFactory(),
  ) {}

  /**
   * @inheritdoc
   */
  public async launch(
    params: AnyLaunchConfiguration,
    context: ILaunchContext,
  ): Promise<LaunchResult> {
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
    this._startServer(this._launchParams);
    await this.launchProgram(this._launchParams);
    return { blockSessionTermination: true };
  }

  /**
   * @inheritdoc
   */
  public async terminate(): Promise<void> {
    if (this.program) {
      await this.program.stop(); // will stop the server when it's done, in launchProgram
    } else {
      this._stopServer();
    }
  }

  /**
   * @inheritdoc
   */
  public async disconnect(): Promise<void> {
    this.terminate();
  }

  /**
   * Restarts the ongoing program.
   */
  public async restart(): Promise<void> {
    if (!this._launchParams) {
      return;
    }

    // connections must be closed, or the process will wait forever:
    this.closeAllConnections();

    // relaunch the program:
    await this.launchProgram(this._launchParams);
  }

  /**
   * Launches the program.
   */
  private async launchProgram(
    params: INodeLaunchConfiguration,
    restartPolicy = this.restarters.create(params),
  ): Promise<void> {
    // Close any existing program. We intentionally don't wait for stop() to
    // finish, since doing so will shut down the server.
    if (this.program) {
      this.program.stop(); // intentionally not awaited on
    }

    const callbackFile = new CallbackFile<IProcessTelemetry>();
    const options = { ...params, env: this.resolveEnvironment(params, callbackFile).value };
    const launcher = this.launchers.find(l => l.canLaunch(options));
    if (!launcher) {
      throw new Error('Cannot find an appropriate launcher for the given set of options');
    }

    const program = (this.program = await launcher.launchProgram(options, this.context!));

    // Once the program stops, dispose of the file. If we started a new program
    // in the meantime, don't do anything. Otherwise, restart if we need to,
    // and if we don't then shut down the server and indicate that we terminated.
    program.stopped.then(async result => {
      callbackFile.dispose();

      if (this.program !== program) {
        return;
      }

      const nextRestart = restartPolicy.next(result);
      if (!nextRestart) {
        this._onTerminatedEmitter.fire(result);
        this._stopServer();
        this.program = undefined;
        return;
      }

      await delay(nextRestart.delay);
      if (this.program === program) {
        this.launchProgram(params, nextRestart);
      }
    });

    // Read the callback file, and signal the running program when we read
    // data. read() retur
    callbackFile.read().then(data => {
      if (data) {
        program.gotTelemetery(data);
      }
    });
  }

  private resolveEnvironment(args: INodeLaunchConfiguration, callbackFile: CallbackFile<any>) {
    let base: { [key: string]: string } = {};

    // read environment variables from any specified file
    if (args.envFile) {
      try {
        base = readEnvFile(args.envFile);
      } catch (e) {
        throw new ProtocolError(cannotLoadEnvironmentVars(e.message));
      }
    }

    const baseEnv = EnvironmentVars.merge(base, args.env);

    return baseEnv.merge({
      NODE_INSPECTOR_IPC: this._pipe || null,
      NODE_INSPECTOR_PPID: '',
      // todo: look at reimplementing the filter
      // NODE_INSPECTOR_WAIT_FOR_DEBUGGER: this._launchParams!.nodeFilter || '',
      NODE_INSPECTOR_WAIT_FOR_DEBUGGER: '',
      // Require our bootloader first, to run it before any other bootloader
      // we could have injected in the parent process.
      NODE_OPTIONS: `--require ${path.join(__dirname, 'bootloader.js')} ${baseEnv.lookup(
        'NODE_OPTIONS',
      ) || ''}`,
      // Supply some node executable for running top-level watchdog in Electron
      // environments. Bootloader will replace this with actual node executable used if any.
      NODE_INSPECTOR_EXEC_PATH: findNode() || '',
      VSCODE_DEBUGGER_FILE_CALLBACK: callbackFile.path,
      VSCODE_DEBUGGER_ONLY_ENTRYPOINT: args.autoAttachChildProcesses ? 'false' : 'true',
      ELECTRON_RUN_AS_NODE: null,
    });
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
    if (this._server) {
      this._server.close();
    }

    this._server = undefined;
    this.closeAllConnections();
  }

  private closeAllConnections() {
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

function readEnvFile(file: string): { [key: string]: string } {
  if (!fs.existsSync(file)) {
    return {};
  }

  const buffer = stripBOM(fs.readFileSync(file, 'utf8'));
  const env = {};
  for (const line of buffer.split('\n')) {
    const r = line.match(/^\s*([\w\.\-]+)\s*=\s*(.*)?\s*$/);
    if (!r) {
      continue;
    }

    let [, key, value = ''] = r;
    // .env variables never overwrite existing variables (see #21169)
    if (value.length > 0 && value.charAt(0) === '"' && value.charAt(value.length - 1) === '"') {
      value = value.replace(/\\n/gm, '\n');
    }
    env[key] = value.replace(/(^['"]|['"]$)/g, '');
  }

  return env;
}

function stripBOM(s: string): string {
  if (s && s[0] === '\uFEFF') {
    s = s.substr(1);
  }
  return s;
}
