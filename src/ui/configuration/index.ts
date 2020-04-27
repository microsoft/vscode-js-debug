/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

export * from './configurationProvider';
import {
  ChromeDebugConfigurationResolver,
  ChromeDebugConfigurationProvider,
} from './chromeDebugConfigurationProvider';
import {
  EdgeDebugConfigurationResolver,
  EdgeDebugConfigurationProvider,
} from './edgeDebugConfigurationProvider';
import { ExtensionHostConfigurationResolver } from './extensionHostConfigurationProvider';
import { NodeConfigurationResolver } from './nodeDebugConfigurationResolver';
import { TerminalDebugConfigurationResolver } from './terminalDebugConfigurationResolver';
import { NodeDebugConfigurationProvider } from './nodeDebugConfigurationProvider';

export const allConfigurationResolvers = [
  ChromeDebugConfigurationResolver,
  EdgeDebugConfigurationResolver,
  ExtensionHostConfigurationResolver,
  NodeConfigurationResolver,
  TerminalDebugConfigurationResolver,
];

export const allConfigurationProviders = [
  ChromeDebugConfigurationProvider,
  EdgeDebugConfigurationProvider,
  NodeDebugConfigurationProvider,
];
