/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { WorkspaceConfiguration } from 'vscode';

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
  NpmScriptLens = 'debug.javascript.codelens.npmScripts',
  WarnOnLongPrediction = 'debug.javascript.warnOnLongPrediction',
}

/**
 * Type map for {@link Configuration} properties.
 */
export interface IConfigurationTypes {
  [Configuration.NpmScriptLens]: 'all' | 'top' | 'never';
  [Configuration.WarnOnLongPrediction]: boolean;
}

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
