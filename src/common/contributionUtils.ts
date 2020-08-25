/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import type { Command, commands, ConfigurationTarget, workspace, WorkspaceFolder } from 'vscode';
import type {
  IChromeLaunchConfiguration,
  INodeAttachConfiguration,
  ITerminalLaunchConfiguration,
} from '../configuration';
import type { IAutoAttachInfo } from '../targets/node/bootloader/environment';
import type { IStartProfileArguments } from '../ui/profiling/uiProfileManager';

export const enum Contributions {
  BrowserBreakpointsView = 'jsBrowserBreakpoints',
}

export const enum Commands {
  AddCustomBreakpoints = 'extension.NAMESPACE(chrome-debug).addCustomBreakpoints',
  AttachProcess = 'extension.NAMESPACE(node-debug).attachNodeProcess',
  AutoAttachClearVariables = 'extension.js-debug.clearAutoAttachVariables',
  AutoAttachSetVariables = 'extension.js-debug.setAutoAttachVariables',
  AutoAttachToProcess = 'extension.js-debug.autoAttachToProcess',
  CreateDebuggerTerminal = 'extension.NAMESPACE(node-debug).createDebuggerTerminal',
  DebugLink = 'extension.js-debug.debugLink',
  DebugNpmScript = 'extension.NAMESPACE(node-debug).npmScript',
  EnlistExperiment = 'extension.js-debug.experimentEnlist',
  PickProcess = 'extension.NAMESPACE(node-debug).pickNodeProcess',
  PrettyPrint = 'extension.NAMESPACE(node-debug).prettyPrint',
  RemoveAllCustomBreakpoints = 'extension.NAMESPACE(chrome-debug).removeAllCustomBreakpoints',
  RemoveCustomBreakpoint = 'extension.NAMESPACE(chrome-debug).removeCustomBreakpoint',
  RevealPage = 'extension.js-debug.revealPage',
  StartProfile = 'extension.NAMESPACE(node-debug).startProfile',
  StopProfile = 'extension.NAMESPACE(node-debug).stopProfile',
  ToggleSkipping = 'extension.NAMESPACE(node-debug).toggleSkippingFile',
}

export const enum DebugType {
  ExtensionHost = 'NAMESPACE(extensionHost)',
  Terminal = 'node-terminal',
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
  [Commands.DebugLink]: null,
  [Commands.DebugNpmScript]: null,
  [Commands.EnlistExperiment]: null,
  [Commands.PickProcess]: null,
  [Commands.PrettyPrint]: null,
  [Commands.RemoveAllCustomBreakpoints]: null,
  [Commands.RemoveCustomBreakpoint]: null,
  [Commands.RevealPage]: null,
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

/**
 * Gets whether the given debug type is one of the js-debug-handled debug types.
 */
export const isDebugType = (debugType: string): debugType is DebugType =>
  allDebugTypes.has(debugType as DebugType);

export const enum AutoAttachMode {
  Explicit = 'explicit',
  Smart = 'smart',
  Always = 'always',
}

export const enum Configuration {
  UsePreviewDebugger = 'debug.javascript.usePreview',
  NpmScriptLens = 'debug.javascript.codelens.npmScripts',
  WarnOnLongPrediction = 'debug.javascript.warnOnLongPrediction',
  TerminalDebugConfig = 'debug.javascript.terminalOptions',
  PickAndAttachDebugOptions = 'debug.javascript.pickAndAttachOptions',
  DebugByLinkOptions = 'debug.javascript.debugByLinkOptions',
  SuggestPrettyPrinting = 'debug.javascript.suggestPrettyPrinting',
  AutoServerTunnelOpen = 'debug.javascript.automaticallyTunnelRemoteServer',
  AutoExpandGetters = 'debug.javascript.autoExpandGetters',
  AutoAttachMode = 'debug.javascript.autoAttachFilter',
  AutoAttachSmartPatterns = 'debug.javascript.autoAttachSmartPattern',
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
  [Configuration.AutoExpandGetters]: boolean;
  [Configuration.AutoAttachMode]: AutoAttachMode;
  [Configuration.AutoAttachSmartPatterns]: ReadonlyArray<string>;
}

export interface ICommandTypes {
  [Commands.DebugNpmScript](folderContainingPackageJson?: string): void;
  [Commands.PickProcess](): string | null;
  [Commands.AttachProcess](): void;
  [Commands.CreateDebuggerTerminal](
    commandToRun?: string,
    workspaceFolder?: WorkspaceFolder,
    config?: Partial<ITerminalLaunchConfiguration>,
  ): void;
  [Commands.ToggleSkipping](file: string | number): void;
  [Commands.PrettyPrint](): void;
  [Commands.EnlistExperiment](): void;
  [Commands.StartProfile](args?: string | IStartProfileArguments): void;
  [Commands.StopProfile](sessionId?: string): void;
  [Commands.AutoAttachSetVariables](): { ipcAddress: string } | void;
  [Commands.AutoAttachClearVariables](): void;
  [Commands.AutoAttachToProcess](info: IAutoAttachInfo): void;
  [Commands.RevealPage](sessionId: string): void;
  [Commands.DebugLink](link?: string): void;
}

/**
 * Typed guard for registering a command.
 */
export const registerCommand = <K extends keyof ICommandTypes>(
  ns: typeof commands,
  key: K,
  fn: (...args: Parameters<ICommandTypes[K]>) => Thenable<ReturnType<ICommandTypes[K]>>,
) => ns.registerCommand(key, fn);

/**
 * Typed guard for running a command.
 */
export const runCommand = async <K extends keyof ICommandTypes>(
  ns: typeof commands,
  key: K,
  ...args: Parameters<ICommandTypes[K]>
): Promise<ReturnType<ICommandTypes[K]>> =>
  (await ns.executeCommand(key, ...args)) as ReturnType<ICommandTypes[K]>;

/**
 * Typed guard for creating a {@link Command} interface.
 */
export const asCommand = <K extends keyof ICommandTypes>(command: {
  title: string;
  command: K;
  tooltip?: string;
  arguments: Parameters<ICommandTypes[K]>;
}): Command => command;

/**
 * Typed guard for reading a contributed config.
 */
export const readConfig = <K extends keyof IConfigurationTypes>(
  wsp: typeof workspace,
  key: K,
  folder?: WorkspaceFolder,
) => wsp.getConfiguration(undefined, folder).get<IConfigurationTypes[K]>(key);

/**
 * Typed guard for updating a contributed config.
 */
export const writeConfig = <K extends keyof IConfigurationTypes>(
  wsp: typeof workspace,
  key: K,
  value: IConfigurationTypes[K],
  target?: ConfigurationTarget,
) => wsp.getConfiguration().update(key, value, target);
