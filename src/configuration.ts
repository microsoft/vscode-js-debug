/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import Dap from './dap/api';
import { Contributions } from './common/contributionUtils';
import { assertNever } from './common/objUtils';
import { AnyRestartOptions } from './targets/node/restartPolicy';

export interface IMandatedConfiguration extends Dap.LaunchParams {
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

  /**
   * VS Code pre-launch task to run.
   */
  preLaunchTask?: string;

  /**
   * Options that configure when the VS Code debug console opens.
   */
  internalConsoleOptions?: 'neverOpen' | 'openOnSessionStart' | 'openOnFirstSessionStart';
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

/**
 * Configuration for async stacks. See {@link IAsyncStackPolicy} for reasoning.
 *  - `true` aliases { onBoot: 32 }
 *  - `false` disables async stacks
 *  - `{ onBoot: N }` enables N async stacks when a target attaches
 *  - `{ onceBreakpointResolved: N }` enables N async stacks the first time a
 *    breakpoint is verified or hit.
 */
export type AsyncStackMode = boolean | { onAttach: number } | { onceBreakpointResolved: number };

export interface IBaseConfiguration extends IMandatedConfiguration {
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
   * Locations that should be scanned while looking for sourcemaps. Patterns
   * can be prefixed with "!" to exclude them.
   */
  outFiles: ReadonlyArray<string>;

  /**
   * Whether to pause when sourcemapped scripts are loaded to load their
   * sourcemap and ensure breakpoints are set.
   */
  pauseForSourceMap: boolean;

  /**
   * Show the async calls that led to the current call stack.
   */
  showAsyncStacks: AsyncStackMode;

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

  /**
   * The value of the ${workspaceFolder} variable
   */
  __workspaceFolder: string;

  /**
   * Cache directory for workspace-related configuration.
   */
  __workspaceCachePath?: string;
}

export interface IExtensionHostConfiguration extends INodeBaseConfiguration {
  type: Contributions.ExtensionHostDebugType;
  request: 'attach' | 'launch';

  /**
   * Command line arguments passed to the program.
   */
  args: ReadonlyArray<string>;

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
export interface INodeBaseConfiguration extends IBaseConfiguration, IConfigurationWithEnv {
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

export interface IConfigurationWithEnv {
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

/**
 * Configuration for a launch request.
 */
export interface INodeLaunchConfiguration extends INodeBaseConfiguration, IConfigurationWithEnv {
  type: Contributions.NodeDebugType;
  request: 'launch';

  /**
   * Program to use to launch the debugger.
   */
  program?: string;

  /**
   * Automatically stop program after launch. It can be set to a boolean, or
   * the absolute filepath to stop in. Setting a path for stopOnEntry should
   * only be needed in esoteric scenarios where it cannot be inferred
   * from the run args.
   */
  stopOnEntry: boolean | string;

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
  restart: AnyRestartOptions;

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
   * Will navigate to this URL and attach to it. This can be omitted to
   * avoid navigation.
   */
  url: string | null;

  /**
   * Will search for a page with this url and attach to it, if found.
   * Can have * wildcards.
   */
  urlFilter: string;

  /**
   * Launch options to boot a server.
   */
  server: INodeLaunchConfiguration | ITerminalLaunchConfiguration | null;
}

/**
 * Opens a debugger-enabled terminal.
 */
export interface ITerminalLaunchConfiguration extends INodeBaseConfiguration {
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
   * Restart session after Node.js has terminated.
   */
  restart: AnyRestartOptions;

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
   * The debug adapter is running elevated. Launch Chrome unelevated to avoid the security restrictions of running Chrome elevated
   */
  launchUnelevated?: boolean;
}

/**
 * Configuration to attach to a Chrome instance.
 */
export interface IChromeAttachConfiguration extends IChromeBaseConfiguration {
  request: 'attach';
}

/**
 * Attach request used internally to inject a pre-built target into the lifecycle.
 */
export interface ITerminalDelegateConfiguration extends INodeBaseConfiguration {
  type: Contributions.TerminalDebugType;
  request: 'attach';
  delegateId: number;
}

export type AnyNodeConfiguration =
  | INodeAttachConfiguration
  | INodeLaunchConfiguration
  | ITerminalLaunchConfiguration
  | IExtensionHostConfiguration
  | ITerminalDelegateConfiguration;
export type AnyChromeConfiguration = IChromeAttachConfiguration | IChromeLaunchConfiguration;
export type AnyLaunchConfiguration = AnyChromeConfiguration | AnyNodeConfiguration;
export type AnyTerminalConfiguration =
  | ITerminalDelegateConfiguration
  | ITerminalLaunchConfiguration;

/**
 * Where T subtypes AnyLaunchConfiguration, gets the resolving version of T.
 */
export type ResolvingConfiguration<T> = IMandatedConfiguration & Partial<T>;

export type ResolvingExtensionHostConfiguration = ResolvingConfiguration<
  IExtensionHostConfiguration
>;
export type ResolvingNodeAttachConfiguration = ResolvingConfiguration<INodeAttachConfiguration>;
export type ResolvingNodeLaunchConfiguration = ResolvingConfiguration<INodeLaunchConfiguration>;
export type ResolvingTerminalDelegateConfiguration = ResolvingConfiguration<
  ITerminalDelegateConfiguration
>;
export type ResolvingTerminalLaunchConfiguration = ResolvingConfiguration<
  ITerminalLaunchConfiguration
>;
export type ResolvingTerminalConfiguration =
  | ResolvingTerminalDelegateConfiguration
  | ResolvingTerminalLaunchConfiguration;
export type ResolvingNodeConfiguration =
  | ResolvingNodeAttachConfiguration
  | ResolvingNodeLaunchConfiguration;
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
  ? ITerminalLaunchConfiguration
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
  pauseForSourceMap: true,
  resolveSourceMapLocations: null,
  rootPath: '${workspaceFolder}',
  outFiles: ['${workspaceFolder}/**/*.js', '!**/node_modules/**'],
  // keep in sync with sourceMapPathOverrides in package.json
  sourceMapPathOverrides: defaultSourceMapPathOverrides('${workspaceFolder}'),
  // Should always be determined upstream
  __workspaceFolder: '',
};

const nodeBaseDefaults: INodeBaseConfiguration = {
  ...baseDefaults,
  cwd: '${workspaceFolder}',
  env: {},
  envFile: null,
  pauseForSourceMap: false,
  sourceMaps: true,
  localRoot: null,
  remoteRoot: null,
  autoAttachChildProcesses: true,
};

export const terminalBaseDefaults: ITerminalLaunchConfiguration = {
  ...nodeBaseDefaults,
  showAsyncStacks: { onceBreakpointResolved: 16 },
  type: Contributions.TerminalDebugType,
  request: 'launch',
  name: 'Debugger Terminal',
};

export const delegateDefaults: ITerminalDelegateConfiguration = {
  ...nodeBaseDefaults,
  type: Contributions.TerminalDebugType,
  request: 'attach',
  name: 'Debugger Terminal',
  showAsyncStacks: { onceBreakpointResolved: 16 },
  delegateId: -1,
};

export const extensionHostConfigDefaults: IExtensionHostConfiguration = {
  ...nodeBaseDefaults,
  type: Contributions.ExtensionHostDebugType,
  name: 'Debug Extension',
  request: 'launch',
  args: ['--extensionDevelopmentPath=${workspaceFolder}'],
  outFiles: ['${workspaceFolder}/out/**/*.js'],
  port: 0,
  resolveSourceMapLocations: ['${workspaceFolder}/**', '!**/node_modules/**'],
  runtimeExecutable: '${execPath}',
};

export const nodeLaunchConfigDefaults: INodeLaunchConfiguration = {
  ...nodeBaseDefaults,
  type: Contributions.NodeDebugType,
  request: 'launch',
  program: '',
  stopOnEntry: false,
  console: 'internalConsole',
  restart: false,
  args: [],
  runtimeExecutable: 'node',
  runtimeVersion: 'default',
  runtimeArgs: [],
};

export const chromeAttachConfigDefaults: IChromeAttachConfiguration = {
  ...baseDefaults,
  type: Contributions.ChromeDebugType,
  request: 'attach',
  port: 0,
  disableNetworkCache: true,
  pathMapping: {},
  url: null,
  urlFilter: '',
  webRoot: '${workspaceFolder}',
  server: null,
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
  userDataDir: false,
};

export const nodeAttachConfigDefaults: INodeAttachConfiguration = {
  ...nodeBaseDefaults,
  type: Contributions.NodeDebugType,
  attachSpawnedProcesses: true,
  attachExistingChildren: true,
  restart: false,
  request: 'attach',
  processId: '',
};

export function defaultSourceMapPathOverrides(webRoot: string): { [key: string]: string } {
  return {
    'webpack://?:*/*': '*',
    'webpack:///./~/*': `${webRoot}/node_modules/*`,
    'meteor://💻app/*': `${webRoot}/*`,
  };
}

export function applyNodeDefaults(config: ResolvingNodeConfiguration): AnyNodeConfiguration {
  return config.request === 'attach'
    ? { ...nodeAttachConfigDefaults, ...config }
    : { ...nodeLaunchConfigDefaults, ...config };
}

export function applyChromeDefaults(config: ResolvingChromeConfiguration): AnyChromeConfiguration {
  return config.request === 'attach'
    ? { ...chromeAttachConfigDefaults, ...config }
    : { ...chromeLaunchConfigDefaults, ...config };
}

export function applyExtensionHostDefaults(
  config: ResolvingExtensionHostConfiguration,
): IExtensionHostConfiguration {
  return { ...extensionHostConfigDefaults, ...config };
}

export function applyTerminalDefaults(
  config: ResolvingTerminalConfiguration,
): AnyTerminalConfiguration {
  return config.request === 'launch'
    ? { ...terminalBaseDefaults, ...config }
    : { ...delegateDefaults, ...config };
}

export const isConfigurationWithEnv = (config: unknown): config is IConfigurationWithEnv =>
  typeof config === 'object' && !!config && 'env' in config && 'envFile' in config;

export function applyDefaults(config: AnyResolvingConfiguration): AnyLaunchConfiguration {
  let configWithDefaults: AnyLaunchConfiguration;
  switch (config.type) {
    case Contributions.NodeDebugType:
      configWithDefaults = applyNodeDefaults(config);
      break;
    case Contributions.ChromeDebugType:
      configWithDefaults = applyChromeDefaults(config);
      break;
    case Contributions.ExtensionHostDebugType:
      configWithDefaults = applyExtensionHostDefaults(config);
      break;
    case Contributions.TerminalDebugType:
      configWithDefaults = applyTerminalDefaults(config);
      break;
    default:
      throw assertNever(config, 'Unknown config: {value}');
  }

  resolveWorkspaceRoot(configWithDefaults);
  return configWithDefaults;
}

function resolveWorkspaceRoot(config: AnyLaunchConfiguration): void {
  resolveVariableInConfig(config, 'workspaceFolder', config.__workspaceFolder);
  resolveVariableInConfig(
    config,
    'webRoot',
    config.type === Contributions.ChromeDebugType ? config.webRoot : config.__workspaceFolder,
  );
}

export function resolveVariableInConfig<T>(config: T, varName: string, varValue: string): void {
  for (const key of Object.keys(config)) {
    const value = config[key];
    if (typeof value === 'string') {
      // eslint-disable-next-line
      config[key] = resolveVariable(value, varName, varValue) as any;
    } else if (typeof value === 'object' && !!value) {
      resolveVariableInConfig(value, varName, varValue);
    }
  }
}

function resolveVariable(entry: string, varName: string, varValue: string): string {
  return entry.replace(new RegExp(`\\$\\{${varName}\\}`, 'g'), varValue);
}

export function isNightly(): boolean {
  try {
    // eslint-disable-next-line
    const packageJson = require('../package.json');
    return packageJson && (packageJson.name as string).includes('nightly');
  } catch (e) {
    return false;
  }
}
