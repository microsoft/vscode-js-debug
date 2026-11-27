/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

export * from './configurationProvider';
import {
  ChromeDebugConfigurationProvider,
  ChromeDebugConfigurationResolver,
} from './chromeDebugConfigurationProvider';
import {
  EdgeDebugConfigurationProvider,
  EdgeDebugConfigurationResolver,
} from './edgeDebugConfigurationProvider';
import {
  EditorBrowserDebugConfigurationProvider,
  EditorBrowserDebugConfigurationResolver,
} from './editorBrowserDebugConfigurationProvider';
import { ExtensionHostConfigurationResolver } from './extensionHostConfigurationResolver';
import {
  NodeDynamicDebugConfigurationProvider,
  NodeInitialDebugConfigurationProvider,
} from './nodeDebugConfigurationProvider';
import { NodeConfigurationResolver } from './nodeDebugConfigurationResolver';
import { ReactNativeConfigurationResolver } from './reactNativeConfigurationResolver';
import { TerminalDebugConfigurationResolver } from './terminalDebugConfigurationResolver';

export const allConfigurationResolvers = [
  ChromeDebugConfigurationResolver,
  EdgeDebugConfigurationResolver,
  EditorBrowserDebugConfigurationResolver,
  ExtensionHostConfigurationResolver,
  NodeConfigurationResolver,
  ReactNativeConfigurationResolver,
  TerminalDebugConfigurationResolver,
];

export const allConfigurationProviders = [
  ChromeDebugConfigurationProvider,
  EdgeDebugConfigurationProvider,
  EditorBrowserDebugConfigurationProvider,
  NodeInitialDebugConfigurationProvider,
  NodeDynamicDebugConfigurationProvider,
];
