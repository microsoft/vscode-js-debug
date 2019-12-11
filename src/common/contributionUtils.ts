/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

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
}
