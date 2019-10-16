export const enum Contributions {
  PrettyPrintCommand = 'extension.NAMESPACE(node-debug).prettyPrint',
  PickLoadedScriptCommand = 'extension.NAMESPACE(node-debug).pickLoadedScript',
  ToggleSkippingCommand = 'extension.NAMESPACE(node-debug).toggleSkippingFile',

  AddCustomBreakpointsCommand = 'extension.NAMESPACE(chrome-debug).addCustomBreakpoints',
  RemoveCustomBreakpointCommand = 'extension.NAMESPACE(chrome-debug).removeCustomBreakpoint',
  RemoveAllCustomBreakpointsCommand = 'extension.NAMESPACE(chrome-debug).removeAllCustomBreakpoints',

  NodeDebugType = 'NAMESPACE(node)',
  ChromeDebugType = 'NAMESPACE(chrome)',
}
