// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import Dap from './dap/api';
import { Contributions } from './common/contributionUtils';

interface IMandatedConfiguration {
  /**
   * The type of the debug session.
   */
  type: string;

  /**
   * The name of the debug session.
   */
  name: string;

  /**
   * The request type of the debug session.
   */
  request: string;
}

export const enum OutputSource {
  Console = 'console',
  Stdio = 'std',
}

export interface ILoggingConfiguration {
  /**
   * Configures whether logs are also returned to the debug console.
   * Defaults to false.
   */
  console: boolean;

  /**
   * Configures the level of logs recorded. Defaults to "Verbose".
   */
  level: string;

  /**
   * Configures where on disk logs are written. If this is null, no logs
   * will be written, otherwise the extension log directory (in VS Code) or
   * OS tmpdir (in VS) will be used.
   */
  logFile: string | null;

  /**
   * Configures what types of logs recorded. For instance, `cdp` will log all
   * CDP protocol messages. If this is empty or not provided, tags will not
   * be filtered.
   */
  tags: ReadonlyArray<string>;
}

export interface IBaseConfiguration extends IMandatedConfiguration, Dap.LaunchParams {
  /**
   * TCP/IP address of process to be debugged (for Node.js >= 5.0 only).
   * Default is 'localhost'.
   */
  address: string;

  /**
   * Debug port to attach to. Default is 5858.
   */
  port: number;

  /**
   * A list of minimatch patterns for locations (folders and URLs) in which
   * source maps can be used to resolve local files. This can be used to avoid
   * incorrectly breaking in external source mapped code. Patterns can be
   * prefixed with "!" to exclude them. May be set to an empty array or null
   * to avoid restriction.
   */
  resolveSourceMapLocations: ReadonlyArray<string> | null;

  /**
   * Show the async calls that led to the current call stack.
   */
  showAsyncStacks: boolean;

  /**
   * An array of glob patterns for files to skip when debugging.
   */
  skipFiles: ReadonlyArray<string>;

  /**
   * Automatically step through generated code that cannot be mapped back to the original source.
   */
  smartStep: boolean;

  /**
   * Use JavaScript source maps (if they exist).
   */
  sourceMaps: boolean;

  /**
   * A set of mappings for rewriting the locations of source files from what
   * the sourcemap says, to their locations on disk.
   */
  sourceMapPathOverrides: { [key: string]: string };

  /**
   * Retry for this number of milliseconds to connect to the debug adapter.
   */
  timeout: number;

  /**
   * Logging configuration
   */
  trace: boolean | Partial<ILoggingConfiguration>;

  /**
   * Location where sources can be found.
   */
  rootPath: string;

  /**
   * From where to capture output messages: The debug API, or stdout/stderr streams.
   */
  outputCapture: OutputSource;
}

export interface IExtensionHostConfiguration extends INodeBaseConfiguration {
  type: Contributions.ExtensionHostDebugType;
  request: 'attach' | 'launch';

  /**
   * Command line arguments passed to the program.
   */
  args: ReadonlyArray<string>;

  /**
   * Environment variables passed to the program. The value `null` removes the
   * variable from the environment.
   */
  env: Readonly<{ [key: string]: string | null }>;

  /**
   * Absolute path to a file containing environment variable definitions.
   */
  envFile: string | null;

  /**
   * If source maps are enabled, these glob patterns specify the generated
   * JavaScript files. If a pattern starts with `!` the files are excluded.
   * If not specified, the generated code is expected in the same directory
   * as its source.
   */
  outFiles: ReadonlyArray<string>;

  /**
   * Path to the VS Code binary.
   */
  runtimeExecutable: string | null;

  /**
   * Extension host session ID. A "magical" value set by VS Code.
   */
  __sessionId?: string;
}

/**
 * Common configuration for the Node debugger.
 */
export interface INodeBaseConfiguration extends IBaseConfiguration {
  /**
   * @internal
   */
  internalConsoleOptions?: string;

  /**
   * Absolute path to the working directory of the program being debugged.
   */
  cwd: string;

  /**
   * If source maps are enabled, these glob patterns specify the generated
   * JavaScript files. If a pattern starts with `!` the files are excluded.
   * If not specified, the generated code is expected in the same directory
   * as its source.
   */
  outFiles: ReadonlyArray<string>;

  /**
   * Path to the local directory containing the program.
   */
  localRoot: string | null;

  /**
   * Path to the remote directory containing the program.
   */
  remoteRoot: string | null;

  /**
   * Attach debugger to new child processes automatically.
   */
  autoAttachChildProcesses: boolean;
}

/**
 * Configuration for a launch request.
 */
export interface INodeLaunchConfiguration extends INodeBaseConfiguration {
  type: Contributions.NodeDebugType;
  request: 'launch';

  /**
   * Program to use to launch the debugger.
   */
  program: string;

  /**
   * Automatically stop program after launch.
   */
  stopOnEntry: boolean;

  /**
   * Where to launch the debug target.
   */
  console: 'internalConsole' | 'integratedTerminal' | 'externalTerminal';

  /**
   * Command line arguments passed to the program.
   */
  args: ReadonlyArray<string>;

  /**
   * Restart session after Node.js has terminated.
   */
  restart: boolean;

  /**
   * Runtime to use. Either an absolute path or the name of a runtime
   * available on the PATH. If omitted `node` is assumed.
   */
  runtimeExecutable: string | null;

  /**
   * Version of `node` runtime to use. Requires `nvm`.
   */
  runtimeVersion: string;

  /**
   * Optional arguments passed to the runtime executable.
   */
  runtimeArgs: ReadonlyArray<string>;

  /**
   * Environment variables passed to the program. The value `null` removes the
   * variable from the environment.
   */
  env: Readonly<{ [key: string]: string | null }>;

  /**
   * Absolute path to a file containing environment variable definitions.
   */
  envFile: string | null;
}

export interface IChromeBaseConfiguration extends IBaseConfiguration {
  type: Contributions.ChromeDebugType;

  /**
   * Controls whether to skip the network cache for each request.
   */
  disableNetworkCache: boolean;

  /**
   * A mapping of URLs/paths to local folders, to resolve scripts
   * in Chrome to scripts on disk
   */
  pathMapping: { [key: string]: string };

  /**
   * This specifies the workspace absolute path to the webserver root. Used to
   * resolve paths like `/app.js` to files on disk. Shorthand for a pathMapping for "/".
   */
  webRoot: string;

  /**
   * Will search for a tab with this exact url and attach to it, if found.
   */
  url: string;

  /**
   * Will search for a page with this url and attach to it, if found.
   * Can have * wildcards.
   */
  urlFilter: string;
}

/**
 * Opens a debugger-enabled terminal.
 */
export interface INodeTerminalConfiguration extends INodeBaseConfiguration {
  type: Contributions.TerminalDebugType;
  request: 'launch';

  /**
   * Command to run.
   */
  command?: string;
}

/**
 * Configuration for an attach request.
 */
export interface INodeAttachConfiguration extends INodeBaseConfiguration {
  type: Contributions.NodeDebugType;
  request: 'attach';

  /**
   * ID of process to attach to.
   */
  processId?: string;

  /**
   * Whether to set environment variables in the attached process to track
   * spawned children.
   */
  attachSpawnedProcesses: boolean;

  /**
   * Whether to attempt to attach to already-spawned child processes.
   */
  attachExistingChildren: boolean;
}

export interface IChromeLaunchConfiguration extends IChromeBaseConfiguration {
  request: 'launch';

  /**
   * Optional working directory for the runtime executable.
   */
  cwd: string | null;

  /**
   * Optional dictionary of environment key/value.
   */
  env: { [key: string]: string | null };

  /**
   * A local html file to open in the browser.
   */
  file: string | null;

  /**
   * Additional browser command line arguments.
   */
  runtimeArgs: ReadonlyArray<string> | null;

  /**
   * Either 'canary', 'stable', 'custom' or path to the browser executable.
   * Custom means a custom wrapper, custom build or CHROME_PATH
   * environment variable.
   */
  runtimeExecutable: string | null;

  /**
   * By default, Chrome is launched with a separate user profile in a temp
   * folder. Use this option to override it. Set to false to launch
   * with your default user profile.
   */
  userDataDir: string | boolean;

  /**
   * Launch options to boot a server.
   */
  server: INodeLaunchConfiguration | null;
}

/**
 * Configuration to attach to a Chrome instance.
 */
export interface IChromeAttachConfiguration extends IChromeBaseConfiguration {
  request: 'attach';
}

export type AnyNodeConfiguration =
  | INodeAttachConfiguration
  | INodeLaunchConfiguration
  | INodeTerminalConfiguration
  | IExtensionHostConfiguration;
export type AnyChromeConfiguration = IChromeAttachConfiguration | IChromeLaunchConfiguration;
export type AnyLaunchConfiguration = AnyChromeConfiguration | AnyNodeConfiguration;

/**
 * Where T subtypes AnyLaunchConfiguration, gets the resolving version of T.
 */
export type ResolvingConfiguration<T> = IMandatedConfiguration & Partial<T>;

export type ResolvingExtensionHostConfiguration = ResolvingConfiguration<
  IExtensionHostConfiguration
>;
export type ResolvingNodeAttachConfiguration = ResolvingConfiguration<INodeAttachConfiguration>;
export type ResolvingNodeLaunchConfiguration = ResolvingConfiguration<INodeLaunchConfiguration>;
export type ResolvingTerminalConfiguration = ResolvingConfiguration<INodeTerminalConfiguration>;
export type ResolvingChromeConfiguration = ResolvingConfiguration<AnyChromeConfiguration>;
export type AnyResolvingConfiguration =
  | ResolvingExtensionHostConfiguration
  | ResolvingChromeConfiguration
  | ResolvingNodeAttachConfiguration
  | ResolvingNodeLaunchConfiguration
  | ResolvingTerminalConfiguration;

/**
 * Where T subtypes AnyResolvingConfiguration, gets the resolved version of T.
 */
export type ResolvedConfiguration<T> = T extends ResolvingNodeAttachConfiguration
  ? INodeAttachConfiguration
  : T extends ResolvingExtensionHostConfiguration
  ? IExtensionHostConfiguration
  : T extends ResolvingNodeLaunchConfiguration
  ? INodeLaunchConfiguration
  : T extends ResolvingChromeConfiguration
  ? AnyChromeConfiguration
  : T extends ResolvingTerminalConfiguration
  ? INodeTerminalConfiguration
  : never;

export const baseDefaults: IBaseConfiguration = {
  type: '',
  name: '',
  request: '',
  trace: false,
  address: 'localhost',
  outputCapture: OutputSource.Console,
  port: 9229,
  timeout: 10000,
  showAsyncStacks: true,
  skipFiles: [],
  smartStep: true,
  sourceMaps: true,
  resolveSourceMapLocations: null,
  rootPath: '${workspaceFolder}',
  // keep in sync with sourceMapPathOverrides in package.json
  sourceMapPathOverrides: {
    'webpack:///*': '*',
    'webpack:///./~/*': '${workspaceFolder}/node_modules/*',
    'meteor://💻app/*': '${workspaceFolder}/*',
  },
};

const nodeBaseDefaults: INodeBaseConfiguration = {
  ...baseDefaults,
  cwd: '${workspaceFolder}',
  sourceMaps: true,
  outFiles: [],
  localRoot: null,
  remoteRoot: null,
  resolveSourceMapLocations: ['${workspaceFolder}/**', '!**/node_modules/**'],
  autoAttachChildProcesses: true,
};

export const terminalBaseDefaults: INodeTerminalConfiguration = {
  ...nodeBaseDefaults,
  type: Contributions.TerminalDebugType,
  request: 'launch',
  name: 'Debugger Terminal',
};

export const extensionHostConfigDefaults: IExtensionHostConfiguration = {
  ...nodeBaseDefaults,
  type: Contributions.ExtensionHostDebugType,
  name: 'Debug Extension',
  request: 'launch',
  args: ['--extensionDevelopmentPath=${workspaceFolder}'],
  runtimeExecutable: '${execPath}',
  env: {},
  envFile: null,
  port: 0,
  outFiles: ['${workspaceFolder}/out/**/*.js'],
};

export const nodeLaunchConfigDefaults: INodeLaunchConfiguration = {
  ...nodeBaseDefaults,
  type: Contributions.NodeDebugType,
  request: 'launch',
  program: '',
  stopOnEntry: false,
  console: 'internalConsole',
  restart: true,
  args: [],
  runtimeExecutable: 'node',
  runtimeVersion: 'default',
  runtimeArgs: [],
  env: {},
  envFile: null,
};

export const chromeAttachConfigDefaults: IChromeAttachConfiguration = {
  ...baseDefaults,
  type: Contributions.ChromeDebugType,
  request: 'attach',
  port: 0,
  disableNetworkCache: true,
  pathMapping: {},
  url: 'http://localhost:8080',
  urlFilter: '',
  webRoot: '${workspaceFolder}',
};

export const chromeLaunchConfigDefaults: IChromeLaunchConfiguration = {
  ...chromeAttachConfigDefaults,
  type: Contributions.ChromeDebugType,
  request: 'launch',
  cwd: null,
  file: null,
  env: {},
  runtimeArgs: null,
  runtimeExecutable: 'stable',
  userDataDir: true,
  server: null,
};

export const nodeAttachConfigDefaults: INodeAttachConfiguration = {
  ...nodeBaseDefaults,
  type: Contributions.NodeDebugType,
  attachSpawnedProcesses: true,
  attachExistingChildren: true,
  request: 'attach',
  processId: '',
};
