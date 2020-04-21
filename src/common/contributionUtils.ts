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
import type { IAutoAttachInfo } from '../targets/node/bootloader/environment';

export const enum Contributions {
  BrowserBreakpointsView = 'jsBrowserBreakpoints',
}

export const enum Commands {
  AddCustomBreakpoints = 'extension.NAMESPACE(chrome-debug).addCustomBreakpoints',
  AttachProcess = 'extension.NAMESPACE(node-debug).attachNodeProcess',
  AutoAttachSetVariables = 'extension.js-debug.setAutoAttachVariables',
  AutoAttachClearVariables = 'extension.js-debug.clearAutoAttachVariables',
  AutoAttachToProcess = 'extension.js-debug.autoAttachToProcess',
  CreateDebuggerTerminal = 'extension.NAMESPACE(node-debug).createDebuggerTerminal',
  DebugNpmScript = 'extension.NAMESPACE(node-debug).npmScript',
  EnlistExperiment = 'extension.js-debug.experimentEnlist',
  PickProcess = 'extension.NAMESPACE(node-debug).pickNodeProcess',
  PrettyPrint = 'extension.NAMESPACE(node-debug).prettyPrint',
  RemoveAllCustomBreakpoints = 'extension.NAMESPACE(chrome-debug).removeAllCustomBreakpoints',
  RemoveCustomBreakpoint = 'extension.NAMESPACE(chrome-debug).removeCustomBreakpoint',
  StartProfile = 'extension.NAMESPACE(node-debug).startProfile',
  StopProfile = 'extension.NAMESPACE(node-debug).stopProfile',
  ToggleSkipping = 'extension.NAMESPACE(node-debug).toggleSkippingFile',
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

const commandsObj: { [K in Commands]: null } = {
  [Commands.AddCustomBreakpoints]: null,
  [Commands.AttachProcess]: null,
  [Commands.AutoAttachClearVariables]: null,
  [Commands.AutoAttachSetVariables]: null,
  [Commands.AutoAttachToProcess]: null,
  [Commands.CreateDebuggerTerminal]: null,
  [Commands.DebugNpmScript]: null,
  [Commands.EnlistExperiment]: null,
  [Commands.PickProcess]: null,
  [Commands.PrettyPrint]: null,
  [Commands.RemoveAllCustomBreakpoints]: null,
  [Commands.RemoveCustomBreakpoint]: null,
  [Commands.StartProfile]: null,
  [Commands.StopProfile]: null,
  [Commands.ToggleSkipping]: null,
};

/**
 * Set of all known commands.
 */
export const allCommands: ReadonlySet<Commands> = new Set(Object.keys(commandsObj));

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
  [Commands.DebugNpmScript]: { args: [WorkspaceFolder?]; out: void };
  [Commands.PickProcess]: { args: []; out: string | null };
  [Commands.AttachProcess]: { args: []; out: void };
  [Commands.CreateDebuggerTerminal]: { args: [string?, WorkspaceFolder?]; out: void };
  [Commands.ToggleSkipping]: { args: [string | number]; out: void };
  [Commands.PrettyPrint]: { args: []; out: void };
  [Commands.EnlistExperiment]: { args: []; out: void };
  [Commands.StartProfile]: {
    args: [string | undefined | IStartProfileArguments];
    out: void;
  };
  [Commands.StopProfile]: { args: [string | undefined]; out: void };
  [Commands.AutoAttachSetVariables]: { args: []; out: { ipcAddress: string } };
  [Commands.AutoAttachClearVariables]: { args: []; out: void };
  [Commands.AutoAttachToProcess]: { args: [IAutoAttachInfo]; out: void };
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
