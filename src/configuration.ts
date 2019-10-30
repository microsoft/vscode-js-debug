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

interface IBaseConfiguration extends IMandatedConfiguration, Dap.LaunchParams {
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
  logging: {
    /**
     * Path to the log file for Chrome DevTools Protocol messages.
     */
    cdp: string | null;
    /**
     * Path to the log file for Debug Adapter Protocol messages.
     */
    dap: string | null;
  };

  /**
   * todo: difference between this and webRoot?
   */
  rootPath?: string;

  /**
   * From where to capture output messages: The debug API, or stdout/stderr streams.
   */
  outputCapture: OutputSource;
}

/**
 * Common configuration for the Node debugger.
 */
export interface INodeBaseConfiguration extends IBaseConfiguration {
  type: Contributions.NodeDebugType;

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
   * Restart session after Node.js has terminated.
   */
  restart: boolean;

  /**
   * Path to the local directory containing the program.
   */
  localRoot: string | null;

  /**
   * Path to the remote directory containing the program.
   */
  remoteRoot: string | null;

  /**
   * Produce diagnostic output. Instead of setting this to true you can
   * list one or more selectors separated with commas. The 'verbose' selector
   * enables very detailed output.
   */
  trace: boolean | string;

  /**
   * Don't set breakpoints in any file until a sourcemap has been
   * loaded for that file.
   */
  disableOptimisticBPs: boolean;

  /**
   * Attach debugger to new child processes automatically.
   */
  autoAttachChildProcesses: boolean;
}

/**
 * Configuration for a launch request.
 */
export interface INodeLaunchConfiguration extends INodeBaseConfiguration {
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

interface IChromeBaseConfiguration extends IBaseConfiguration {
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
 * Configuration for an attach request.
 */
export interface INodeAttachConfiguration extends INodeBaseConfiguration {
  request: 'attach';

  /**
   * ID of process to attach to.
   */
  processId?: string;
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
  runtimeExecutable: string;

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

export type AnyNodeConfiguration = INodeAttachConfiguration | INodeLaunchConfiguration;
export type AnyChromeConfiguration = IChromeAttachConfiguration | IChromeLaunchConfiguration;
export type AnyLaunchConfiguration = AnyChromeConfiguration | AnyNodeConfiguration;

export type ResolvingNodeAttachConfiguration = IMandatedConfiguration & Partial<INodeAttachConfiguration>;
export type ResolvingNodeLaunchConfiguration = IMandatedConfiguration & Partial<INodeLaunchConfiguration>;
export type ResolvingNodeConfiguration = ResolvingNodeAttachConfiguration | ResolvingNodeLaunchConfiguration;
export type ResolvingChromeConfiguration = IMandatedConfiguration & Partial<AnyChromeConfiguration>;

export const baseDefaults: IBaseConfiguration = {
  type: '',
  name: '',
  request: '',
  logging: {
    cdp: null,
    dap: null,
  },
  address: 'localhost',
  outputCapture: OutputSource.Console,
  port: 9229,
  timeout: 10000,
  showAsyncStacks: true,
  skipFiles: [],
  smartStep: true,
  sourceMaps: true,
  // keep in sync with sourceMapPathOverrides in package.json
  sourceMapPathOverrides: {
    'webpack:///*': '*',
    'webpack:///./~/*': '${workspaceFolder}/node_modules/*',
    'meteor://💻app/*': '${workspaceFolder}/*',
  },
};

const nodeBaseDefaults: INodeBaseConfiguration = {
  ...baseDefaults,
  type: Contributions.NodeDebugType,
  cwd: '${workspaceFolder}',
  sourceMaps: true,
  outFiles: [],
  restart: true,
  localRoot: null,
  remoteRoot: null,
  trace: true,
  disableOptimisticBPs: true,
  autoAttachChildProcesses: true,
};

export const nodeLaunchConfigDefaults: INodeLaunchConfiguration = {
  ...nodeBaseDefaults,
  request: 'launch',
  program: '',
  stopOnEntry: true,
  console: 'internalConsole',
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
  request: 'attach',
  processId: '',
};
