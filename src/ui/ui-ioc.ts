/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { Container } from 'inversify';
import { trackDispose } from '../ioc-extras';
import {
  allConfigurationProviders,
  allConfigurationResolvers,
  IDebugConfigurationProvider,
  IDebugConfigurationResolver,
} from './configuration';
import { DebugLinkUi } from './debugLinkUI';
import { DebugSessionTracker } from './debugSessionTracker';
import { BreakpointTerminationConditionFactory } from './profiling/breakpointTerminationCondition';
import { DurationTerminationConditionFactory } from './profiling/durationTerminationCondition';
import { ManualTerminationConditionFactory } from './profiling/manualTerminationCondition';
import { ITerminationConditionFactory } from './profiling/terminationCondition';
import { UiProfileManager } from './profiling/uiProfileManager';
import { TerminalLinkHandler } from './terminalLinkHandler';

export const registerUiComponents = (container: Container) => {
  allConfigurationResolvers.forEach(cls => {
    container
      .bind(cls as { new (...args: unknown[]): unknown })
      .toSelf()
      .inSingletonScope();
    container.bind(IDebugConfigurationResolver).to(cls);
  });

  allConfigurationProviders.forEach(cls =>
    container.bind(IDebugConfigurationProvider).to(cls).inSingletonScope(),
  );

  container.bind(DebugSessionTracker).toSelf().inSingletonScope().onActivation(trackDispose);
  container.bind(UiProfileManager).toSelf().inSingletonScope().onActivation(trackDispose);
  container.bind(TerminalLinkHandler).toSelf().inSingletonScope();
  container.bind(DebugLinkUi).toSelf().inSingletonScope();

  container
    .bind(ITerminationConditionFactory)
    .to(DurationTerminationConditionFactory)
    .inSingletonScope();
  container
    .bind(ITerminationConditionFactory)
    .to(ManualTerminationConditionFactory)
    .inSingletonScope();
  container
    .bind(ITerminationConditionFactory)
    .to(BreakpointTerminationConditionFactory)
    .inSingletonScope();
};
