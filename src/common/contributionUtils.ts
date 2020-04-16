/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import type {
  Command,
  WorkspaceConfiguration,
  WorkspaceFolder,
  commands,
  ConfigurationTarget,
} from 'vscode';
import type {
  ITerminalLaunchConfiguration,
  IChromeLaunchConfiguration,
  INodeAttachConfiguration,
} from '../configuration';
import type { IStartProfileArguments } from '../ui/profiling/uiProfileManager';

export const enum Contributions {
  PrettyPrintCommand = 'extension.NAMESPACE(node-debug).prettyPrint',
  ToggleSkippingCommand = 'extension.NAMESPACE(node-debug).toggleSkippingFile',
  PickProcessCommand = 'extension.NAMESPACE(node-debug).pickNodeProcess',
  AttachProcessCommand = 'extension.NAMESPACE(node-debug).attachNodeProcess',
  DebugNpmScript = 'extension.NAMESPACE(node-debug).npmScript',
  CreateDebuggerTerminal = 'extension.NAMESPACE(node-debug).createDebuggerTerminal',

  EnlistExperimentCommand = 'extension.js-debug.experimentEnlist',
  AddCustomBreakpointsCommand = 'extension.NAMESPACE(chrome-debug).addCustomBreakpoints',
  RemoveCustomBreakpointCommand = 'extension.NAMESPACE(chrome-debug).removeCustomBreakpoint',
  RemoveAllCustomBreakpointsCommand = 'extension.NAMESPACE(chrome-debug).removeAllCustomBreakpoints',
  StartProfileCommand = 'extension.NAMESPACE(node-debug).startProfile',
  StopProfileCommand = 'extension.NAMESPACE(node-debug).stopProfile',

  BrowserBreakpointsView = 'jsBrowserBreakpoints',
}

export const enum DebugType {
  ExtensionHost = 'NAMESPACE(extensionHost)',
  Terminal = 'NAMESPACE(node-terminal)',
  Node = 'NAMESPACE(node)',
  Chrome = 'NAMESPACE(chrome)',
  Edge = 'NAMESPACE(msedge)',
}

// constructing it this way makes sure we can't forget to add a type:
const debugTypes: { [K in DebugType]: null } = {
  [DebugType.ExtensionHost]: null,
  [DebugType.Terminal]: null,
  [DebugType.Node]: null,
  [DebugType.Chrome]: null,
  [DebugType.Edge]: null,
};

/**
 * Set of all known debug types.
 */
export const allDebugTypes: ReadonlySet<DebugType> = new Set(Object.keys(debugTypes));

export const enum Configuration {
  UsePreviewDebugger = 'debug.javascript.usePreview',
  NpmScriptLens = 'debug.javascript.codelens.npmScripts',
  WarnOnLongPrediction = 'debug.javascript.warnOnLongPrediction',
  TerminalDebugConfig = 'debug.javascript.terminalOptions',
  PickAndAttachDebugOptions = 'debug.javascript.pickAndAttachOptions',
  DebugByLinkOptions = 'debug.javascript.debugByLinkOptions',
  SuggestPrettyPrinting = 'debug.javascript.suggestPrettyPrinting',
  AutoServerTunnelOpen = 'debug.javascript.automaticallyTunnelRemoteServer',
}

export type DebugByLinkState = 'on' | 'off' | 'always';

/**
 * Type map for {@link Configuration} properties.
 */
export interface IConfigurationTypes {
  [Configuration.UsePreviewDebugger]: boolean;
  [Configuration.NpmScriptLens]: 'all' | 'top' | 'never';
  [Configuration.WarnOnLongPrediction]: boolean;
  [Configuration.TerminalDebugConfig]: Partial<ITerminalLaunchConfiguration>;
  [Configuration.PickAndAttachDebugOptions]: Partial<INodeAttachConfiguration>;
  [Configuration.SuggestPrettyPrinting]: boolean;
  [Configuration.AutoServerTunnelOpen]: boolean;
  [Configuration.DebugByLinkOptions]:
    | DebugByLinkState
    | ({ enabled: DebugByLinkState } & Partial<IChromeLaunchConfiguration>);
}

export interface ICommandTypes {
  [Contributions.DebugNpmScript]: { args: [WorkspaceFolder?]; out: void };
  [Contributions.PickProcessCommand]: { args: []; out: string | null };
  [Contributions.AttachProcessCommand]: { args: []; out: void };
  [Contributions.CreateDebuggerTerminal]: { args: [string?, WorkspaceFolder?]; out: void };
  [Contributions.ToggleSkippingCommand]: { args: [string | number]; out: void };
  [Contributions.PrettyPrintCommand]: { args: []; out: void };
  [Contributions.EnlistExperimentCommand]: { args: []; out: void };
  [Contributions.StartProfileCommand]: {
    args: [string | undefined | IStartProfileArguments];
    out: void;
  };
  [Contributions.StopProfileCommand]: { args: [string | undefined]; out: void };
}

/**
 * Typed guard for registering a command.
 */
export const registerCommand = <K extends keyof ICommandTypes>(
  ns: typeof commands,
  key: K,
  fn: (...args: ICommandTypes[K]['args']) => Promise<ICommandTypes[K]['out']>,
) => ns.registerCommand(key, fn);

/**
 * Typed guard for running a command.
 */
export const runCommand = async <K extends keyof ICommandTypes>(
  ns: typeof commands,
  key: K,
  ...args: ICommandTypes[K]['args']
): Promise<ICommandTypes[K]['out']> => await ns.executeCommand(key, ...args);

/**
 * Typed guard for creating a {@link Command} interface.
 */
export const asCommand = <K extends keyof ICommandTypes>(command: {
  title: string;
  command: K;
  tooltip?: string;
  arguments: ICommandTypes[K]['args'];
}): Command => command;

/**
 * Typed guard for reading a contributed config.
 */
export const readConfig = <K extends keyof IConfigurationTypes>(
  config: WorkspaceConfiguration,
  key: K,
) => config.get<IConfigurationTypes[K]>(key);

/**
 * Typed guard for updating a contributed config.
 */
export const writeConfig = <K extends keyof IConfigurationTypes>(
  config: WorkspaceConfiguration,
  key: K,
  value: IConfigurationTypes[K],
  target?: ConfigurationTarget,
) => config.update(key, value, target);
