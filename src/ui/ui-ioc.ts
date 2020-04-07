/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { Container } from 'inversify';
import {
  ChromeDebugConfigurationProvider,
  EdgeDebugConfigurationProvider,
  ExtensionHostConfigurationProvider,
  NodeConfigurationProvider,
  TerminalDebugConfigurationProvider,
  IDebugConfigurationProvider,
} from './configuration';
import { UiProfileManager } from './profiling/uiProfileManager';
import { DebugSessionTracker } from './debugSessionTracker';
import { trackDispose } from '../ioc-extras';

export const registerUiComponents = (container: Container) => {
  [
    ChromeDebugConfigurationProvider,
    EdgeDebugConfigurationProvider,
    ExtensionHostConfigurationProvider,
    NodeConfigurationProvider,
    TerminalDebugConfigurationProvider,
  ].forEach(cls => {
    container
      .bind(cls as { new (...args: unknown[]): unknown })
      .toSelf()
      .inSingletonScope();
    container.bind(IDebugConfigurationProvider).to(cls);
  });

  container.bind(DebugSessionTracker).toSelf().inSingletonScope().onActivation(trackDispose);
  container.bind(UiProfileManager).toSelf().inSingletonScope().onActivation(trackDispose);
};
