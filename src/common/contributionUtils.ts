/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { OptionsOfBufferResponseBody } from 'got';
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
  DiagnosticsView = 'jsDebugDiagnostics',
}

export const enum Commands {
  AddCustomBreakpoints = 'extension.js-debug.addCustomBreakpoints',
  AttachProcess = 'extension.pwa-node-debug.attachNodeProcess',
  AutoAttachClearVariables = 'extension.js-debug.clearAutoAttachVariables',
  AutoAttachSetVariables = 'extension.js-debug.setAutoAttachVariables',
  AutoAttachToProcess = 'extension.js-debug.autoAttachToProcess',
  CreateDebuggerTerminal = 'extension.js-debug.createDebuggerTerminal',
  CreateDiagnostics = 'extension.js-debug.createDiagnostics',
  DebugLink = 'extension.js-debug.debugLink',
  DebugNpmScript = 'extension.js-debug.npmScript',
  PickProcess = 'extension.js-debug.pickNodeProcess',
  PrettyPrint = 'extension.js-debug.prettyPrint',
  RemoveAllCustomBreakpoints = 'extension.js-debug.removeAllCustomBreakpoints',
  RemoveCustomBreakpoint = 'extension.js-debug.removeCustomBreakpoint',
  RevealPage = 'extension.js-debug.revealPage',
  RequestCDPProxy = 'extension.js-debug.requestCDPProxy',
  /** Use node-debug's command so existing keybindings work */
  StartWithStopOnEntry = 'extension.node-debug.startWithStopOnEntry',
  StartProfile = 'extension.js-debug.startProfile',
  StopProfile = 'extension.js-debug.stopProfile',
  ToggleSkipping = 'extension.js-debug.toggleSkippingFile',
  OpenEdgeDevTools = 'extension.js-debug.openEdgeDevTools',
}

export const preferredDebugTypes: ReadonlyMap<DebugType, string> = new Map([
  [DebugType.Node, 'node'],
  [DebugType.Chrome, 'chrome'],
  [DebugType.ExtensionHost, 'extensionHost'],
  [DebugType.Edge, 'msedge'],
]);

export const enum DebugType {
  ExtensionHost = 'pwa-extensionHost',
  Terminal = 'node-terminal',
  Node = 'pwa-node',
  Chrome = 'pwa-chrome',
  Edge = 'pwa-msedge',
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
  [Commands.CreateDiagnostics]: null,
  [Commands.DebugLink]: null,
  [Commands.DebugNpmScript]: null,
  [Commands.PickProcess]: null,
  [Commands.PrettyPrint]: null,
  [Commands.RemoveAllCustomBreakpoints]: null,
  [Commands.RemoveCustomBreakpoint]: null,
  [Commands.RevealPage]: null,
  [Commands.StartProfile]: null,
  [Commands.StopProfile]: null,
  [Commands.ToggleSkipping]: null,
  [Commands.StartWithStopOnEntry]: null,
  [Commands.RequestCDPProxy]: null,
  [Commands.OpenEdgeDevTools]: null,
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
export const isDebugType = (debugType: unknown): debugType is DebugType =>
  allDebugTypes.has(debugType as DebugType);

export const enum AutoAttachMode {
  Disabled = 'disabled',
  OnlyWithFlag = 'onlyWithFlag',
  Smart = 'smart',
  Always = 'always',
}
export const enum Configuration {
  NpmScriptLens = 'debug.javascript.codelens.npmScripts',
  TerminalDebugConfig = 'debug.javascript.terminalOptions',
  PickAndAttachDebugOptions = 'debug.javascript.pickAndAttachOptions',
  DebugByLinkOptions = 'debug.javascript.debugByLinkOptions',
  SuggestPrettyPrinting = 'debug.javascript.suggestPrettyPrinting',
  AutoServerTunnelOpen = 'debug.javascript.automaticallyTunnelRemoteServer',
  AutoExpandGetters = 'debug.javascript.autoExpandGetters',
  AutoAttachMode = 'debug.javascript.autoAttachFilter',
  AutoAttachSmartPatterns = 'debug.javascript.autoAttachSmartPattern',
  BreakOnConditionalError = 'debug.javascript.breakOnConditionalError',
  UnmapMissingSources = 'debug.javascript.unmapMissingSources',
  DefaultRuntimeExecutables = 'debug.javascript.defaultRuntimeExecutable',
  ResourceRequestOptions = 'debug.javascript.resourceRequestOptions',
}

export type DebugByLinkState = 'on' | 'off' | 'always';

/**
 * Type map for {@link Configuration} properties.
 */
export interface IConfigurationTypes {
  [Configuration.NpmScriptLens]: 'all' | 'top' | 'never';
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
  [Configuration.BreakOnConditionalError]: boolean;
  [Configuration.UnmapMissingSources]: boolean;
  [Configuration.DefaultRuntimeExecutables]: { [K in DebugType]?: string };
  [Configuration.ResourceRequestOptions]: Partial<OptionsOfBufferResponseBody>;
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
  [Commands.CreateDiagnostics](): void;
  [Commands.ToggleSkipping](file: string | number): void;
  [Commands.PrettyPrint](): void;
  [Commands.StartProfile](args?: string | IStartProfileArguments): void;
  [Commands.StopProfile](sessionId?: string): void;
  [Commands.AutoAttachSetVariables](): { ipcAddress: string } | void;
  [Commands.AutoAttachClearVariables](): void;
  [Commands.AutoAttachToProcess](info: IAutoAttachInfo): void;
  [Commands.RevealPage](sessionId: string): void;
  [Commands.DebugLink](link?: string): void;
  [Commands.StartWithStopOnEntry](): void;
  [Commands.RequestCDPProxy](
    sessionId: string,
    forwardToUi?: boolean,
  ): { host: string; port: number; path: string } | undefined;
  [Commands.OpenEdgeDevTools](): void;
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
