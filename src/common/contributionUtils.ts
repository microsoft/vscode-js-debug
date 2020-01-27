/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { Command, WorkspaceConfiguration, WorkspaceFolder, commands } from 'vscode';
import { ITerminalLaunchConfiguration } from '../configuration';

export const enum Contributions {
  PrettyPrintCommand = 'extension.NAMESPACE(node-debug).prettyPrint',
  ToggleSkippingCommand = 'extension.NAMESPACE(node-debug).toggleSkippingFile',
  PickProcessCommand = 'extension.NAMESPACE(node-debug).pickNodeProcess',
  AttachProcessCommand = 'extension.NAMESPACE(node-debug).attachNodeProcess',
  DebugNpmScript = 'extension.NAMESPACE(node-debug).npmScript',
  CreateDebuggerTerminal = 'extension.NAMESPACE(node-debug).createDebuggerTerminal',

  AddCustomBreakpointsCommand = 'extension.NAMESPACE(chrome-debug).addCustomBreakpoints',
  RemoveCustomBreakpointCommand = 'extension.NAMESPACE(chrome-debug).removeCustomBreakpoint',
  RemoveAllCustomBreakpointsCommand = 'extension.NAMESPACE(chrome-debug).removeAllCustomBreakpoints',

  ExtensionHostDebugType = 'NAMESPACE(extensionHost)',
  TerminalDebugType = 'NAMESPACE(node-terminal)',
  NodeDebugType = 'NAMESPACE(node)',
  ChromeDebugType = 'NAMESPACE(chrome)',

  BrowserBreakpointsView = 'jsBrowserBreakpoints',
}

export const enum Configuration {
  UsePreviewDebugger = 'debug.javascript.usePreview',
  NpmScriptLens = 'debug.javascript.codelens.npmScripts',
  WarnOnLongPrediction = 'debug.javascript.warnOnLongPrediction',
  TerminalDebugConfig = 'debug.javascript.terminalOptions',
}

/**
 * Type map for {@link Configuration} properties.
 */
export interface IConfigurationTypes {
  [Configuration.UsePreviewDebugger]: boolean;
  [Configuration.NpmScriptLens]: 'all' | 'top' | 'never';
  [Configuration.WarnOnLongPrediction]: boolean;
  [Configuration.TerminalDebugConfig]: Partial<ITerminalLaunchConfiguration>;
}

export interface ICommandTypes {
  [Contributions.DebugNpmScript]: { args: [WorkspaceFolder?]; out: void };
  [Contributions.PickProcessCommand]: { args: []; out: string | null };
  [Contributions.AttachProcessCommand]: { args: []; out: void };
  [Contributions.CreateDebuggerTerminal]: { args: [string?, WorkspaceFolder?]; out: void };
  [Contributions.ToggleSkippingCommand]: { args: [string | number]; out: void };
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
) => config.update(key, value);
