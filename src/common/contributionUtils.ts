/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import type { OptionsOfBufferResponseBody } from 'got';
import type { Command, commands, ConfigurationTarget, workspace, WorkspaceFolder } from 'vscode';
import type * as vscode from 'vscode';
import type {
  IChromeLaunchConfiguration,
  INodeAttachConfiguration,
  ITerminalLaunchConfiguration,
} from '../configuration';
import type Dap from '../dap/api';
import type { IAutoAttachInfo } from '../targets/node/bootloader/environment';
import type { ExcludedCaller } from '../ui/excludedCallersUI';
import type { NetworkRequest } from '../ui/networkTree';
import type { IStartProfileArguments } from '../ui/profiling/uiProfileManager';

export const enum Contributions {
  BrowserBreakpointsView = 'jsBrowserBreakpoints',
  XHRFetchBreakpointsView = 'jsXHRBreakpoints',
  DiagnosticsView = 'jsDebugDiagnostics',
}

export const enum CustomViews {
  EventListenerBreakpoints = 'jsBrowserBreakpoints',
  XHRFetchBreakpoints = 'jsXHRBreakpoints',
  ExcludedCallers = 'jsExcludedCallers',
  Network = 'jsDebugNetworkTree',
}

export const enum Commands {
  ToggleCustomBreakpoints = 'extension.js-debug.addCustomBreakpoints',
  AddXHRBreakpoints = 'extension.js-debug.addXHRBreakpoints',
  EditXHRBreakpoint = 'extension.js-debug.editXHRBreakpoints',
  AttachProcess = 'extension.pwa-node-debug.attachNodeProcess',
  AutoAttachClearVariables = 'extension.js-debug.clearAutoAttachVariables',
  AutoAttachSetVariables = 'extension.js-debug.setAutoAttachVariables',
  AutoAttachToProcess = 'extension.js-debug.autoAttachToProcess',
  CreateDebuggerTerminal = 'extension.js-debug.createDebuggerTerminal',
  CreateDiagnostics = 'extension.js-debug.createDiagnostics',
  GetDiagnosticLogs = 'extension.js-debug.getDiagnosticLogs',
  DebugLink = 'extension.js-debug.debugLink',
  DebugNpmScript = 'extension.js-debug.npmScript',
  PickProcess = 'extension.js-debug.pickNodeProcess',
  PrettyPrint = 'extension.js-debug.prettyPrint',
  RemoveAllCustomBreakpoints = 'extension.js-debug.removeAllCustomBreakpoints',
  RemoveXHRBreakpoints = 'extension.js-debug.removeXHRBreakpoint',
  RevealPage = 'extension.js-debug.revealPage',
  RequestCDPProxy = 'extension.js-debug.requestCDPProxy',
  /** Use node-debug's command so existing keybindings work */
  StartWithStopOnEntry = 'extension.node-debug.startWithStopOnEntry',
  StartProfile = 'extension.js-debug.startProfile',
  StopProfile = 'extension.js-debug.stopProfile',
  ToggleSkipping = 'extension.js-debug.toggleSkippingFile',
  OpenEdgeDevTools = 'extension.js-debug.openEdgeDevTools',
  DisableSourceMapStepping = 'extension.js-debug.disableSourceMapStepping',
  EnableSourceMapStepping = 'extension.js-debug.enableSourceMapStepping',
  // #region Excluded callers view
  CallersGoToCaller = 'extension.js-debug.callers.goToCaller',
  CallersGoToTarget = 'extension.js-debug.callers.gotToTarget',
  CallersRemove = 'extension.js-debug.callers.remove',
  CallersRemoveAll = 'extension.js-debug.callers.removeAll',
  CallersAdd = 'extension.js-debug.callers.add',
  // #endregion
  // #region Network view
  NetworkViewRequest = 'extension.js-debug.network.viewRequest',
  NetworkCopyUri = 'extension.js-debug.network.copyUri',
  NetworkOpenBody = 'extension.js-debug.network.openBody',
  NetworkOpenBodyHex = 'extension.js-debug.network.openBodyInHex',
  NetworkReplayXHR = 'extension.js-debug.network.replayXHR',
  NetworkClear = 'extension.js-debug.network.clear',
  // #endregion
  // #region completions
  CompletionNodeTool = 'extension.js-debug.completion.nodeTool',
  // #endregion
}

export const enum DebugType {
  ExtensionHost = 'pwa-extensionHost',
  Terminal = 'node-terminal',
  Node = 'pwa-node',
  Chrome = 'pwa-chrome',
  Edge = 'pwa-msedge',
}

export const preferredDebugTypes: ReadonlyMap<DebugType, string> = new Map([
  [DebugType.Node, 'node'],
  [DebugType.Chrome, 'chrome'],
  [DebugType.ExtensionHost, 'extensionHost'],
  [DebugType.Edge, 'msedge'],
]);

export const getPreferredOrDebugType = <T extends DebugType>(t: T) =>
  (preferredDebugTypes.get(t) as T) || t;

// constructing it this way makes sure we can't forget to add a type:
const debugTypes: { [K in DebugType]: null } = {
  [DebugType.ExtensionHost]: null,
  [DebugType.Terminal]: null,
  [DebugType.Node]: null,
  [DebugType.Chrome]: null,
  [DebugType.Edge]: null,
};

const commandsObj: { [K in Commands]: null } = {
  [Commands.ToggleCustomBreakpoints]: null,
  [Commands.AddXHRBreakpoints]: null,
  [Commands.EditXHRBreakpoint]: null,
  [Commands.AttachProcess]: null,
  [Commands.AutoAttachClearVariables]: null,
  [Commands.AutoAttachSetVariables]: null,
  [Commands.AutoAttachToProcess]: null,
  [Commands.CreateDebuggerTerminal]: null,
  [Commands.CreateDiagnostics]: null,
  [Commands.GetDiagnosticLogs]: null,
  [Commands.DebugLink]: null,
  [Commands.DebugNpmScript]: null,
  [Commands.PickProcess]: null,
  [Commands.PrettyPrint]: null,
  [Commands.RemoveXHRBreakpoints]: null,
  [Commands.RemoveAllCustomBreakpoints]: null,
  [Commands.RevealPage]: null,
  [Commands.StartProfile]: null,
  [Commands.StopProfile]: null,
  [Commands.ToggleSkipping]: null,
  [Commands.StartWithStopOnEntry]: null,
  [Commands.RequestCDPProxy]: null,
  [Commands.OpenEdgeDevTools]: null,
  [Commands.CallersAdd]: null,
  [Commands.CallersGoToCaller]: null,
  [Commands.CallersGoToTarget]: null,
  [Commands.CallersRemove]: null,
  [Commands.CallersRemoveAll]: null,
  [Commands.EnableSourceMapStepping]: null,
  [Commands.DisableSourceMapStepping]: null,
  [Commands.NetworkViewRequest]: null,
  [Commands.NetworkCopyUri]: null,
  [Commands.NetworkOpenBody]: null,
  [Commands.NetworkOpenBodyHex]: null,
  [Commands.NetworkReplayXHR]: null,
  [Commands.NetworkClear]: null,
  [Commands.CompletionNodeTool]: null,
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
  AutoServerTunnelOpen = 'debug.javascript.automaticallyTunnelRemoteServer',
  AutoAttachMode = 'debug.javascript.autoAttachFilter',
  AutoAttachSmartPatterns = 'debug.javascript.autoAttachSmartPattern',
  BreakOnConditionalError = 'debug.javascript.breakOnConditionalError',
  UnmapMissingSources = 'debug.javascript.unmapMissingSources',
  DefaultRuntimeExecutables = 'debug.javascript.defaultRuntimeExecutable',
  ResourceRequestOptions = 'debug.javascript.resourceRequestOptions',
  EnableNetworkView = 'debug.javascript.enableNetworkView',
}

export type DebugByLinkState = 'on' | 'off' | 'always';

/**
 * Type map for {@link Configuration} properties.
 */
export interface IConfigurationTypes {
  [Configuration.NpmScriptLens]: 'all' | 'top' | 'never';
  [Configuration.TerminalDebugConfig]: Partial<ITerminalLaunchConfiguration>;
  [Configuration.PickAndAttachDebugOptions]: Partial<INodeAttachConfiguration>;
  [Configuration.AutoServerTunnelOpen]: boolean;
  [Configuration.DebugByLinkOptions]:
    | DebugByLinkState
    | ({ enabled: DebugByLinkState } & Partial<IChromeLaunchConfiguration>);
  [Configuration.AutoAttachMode]: AutoAttachMode;
  [Configuration.AutoAttachSmartPatterns]: ReadonlyArray<string>;
  [Configuration.BreakOnConditionalError]: boolean;
  [Configuration.UnmapMissingSources]: boolean;
  [Configuration.DefaultRuntimeExecutables]: { [K in DebugType]?: string };
  [Configuration.ResourceRequestOptions]: Partial<OptionsOfBufferResponseBody>;
  [Configuration.EnableNetworkView]: boolean;
}

export interface IStackFrameContext {
  sessionId: string;
  frameName: string;
  frameId: string;
  frameLocation: {
    range: { startLineNumber: number; startColumn: number };
    source: Dap.Source;
  };
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
  [Commands.GetDiagnosticLogs](): void;
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

  [Commands.CallersAdd](uri: string, context: IStackFrameContext): void;
  [Commands.CallersGoToCaller](caller: ExcludedCaller): void;
  [Commands.CallersGoToTarget](caller: ExcludedCaller): void;
  [Commands.CallersRemove](caller: ExcludedCaller): void;
  [Commands.CallersRemoveAll](): void;
  [Commands.EnableSourceMapStepping](): void;
  [Commands.DisableSourceMapStepping](): void;
  [Commands.NetworkViewRequest](request: NetworkRequest): void;
  [Commands.NetworkCopyUri](request: NetworkRequest): void;
  [Commands.NetworkOpenBody](request: NetworkRequest): void;
  [Commands.NetworkOpenBodyHex](request: NetworkRequest): void;
  [Commands.NetworkReplayXHR](request: NetworkRequest): void;
  [Commands.NetworkClear](): void;
  [Commands.CompletionNodeTool](doc: vscode.TextDocument, position: vscode.Position): void;
}

export const networkFilesystemScheme = 'jsDebugNetworkFs';

/**
 * Typed guard for registering a command.
 */
export const registerCommand = <K extends keyof ICommandTypes>(
  ns: typeof commands,
  key: K,
  fn: (
    ...args: Parameters<ICommandTypes[K]>
  ) => void extends ReturnType<ICommandTypes[K]> ? void : Thenable<ReturnType<ICommandTypes[K]>>,
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

export const enum ContextKey {
  HasExcludedCallers = 'jsDebugHasExcludedCallers',
  CanPrettyPrint = 'jsDebugCanPrettyPrint',
  IsProfiling = 'jsDebugIsProfiling',
  IsMapSteppingDisabled = 'jsDebugIsMapSteppingDisabled',
  NetworkAvailable = 'jsDebugNetworkAvailable',
}

export interface IContextKeyTypes {
  [ContextKey.HasExcludedCallers]: boolean;
  [ContextKey.CanPrettyPrint]: string[];
  [ContextKey.IsProfiling]: boolean;
  [ContextKey.IsMapSteppingDisabled]: boolean;
  [ContextKey.NetworkAvailable]: boolean;
}

export const setContextKey = async <K extends keyof IContextKeyTypes>(
  ns: typeof commands,
  key: K,
  value: IContextKeyTypes[K] | null,
) => await ns.executeCommand('setContext', key, value);
