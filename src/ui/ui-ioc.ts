/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { Container } from 'inversify';
import {
  IDebugConfigurationResolver,
  allConfigurationResolvers,
  allConfigurationProviders,
  IDebugConfigurationProvider,
} from './configuration';
import { UiProfileManager } from './profiling/uiProfileManager';
import { DebugSessionTracker } from './debugSessionTracker';
import { trackDispose } from '../ioc-extras';
import { TerminalLinkHandler } from './terminalLinkHandler';
import { ITerminationConditionFactory } from './profiling/terminationCondition';
import { DurationTerminationConditionFactory } from './profiling/durationTerminationCondition';
import { ManualTerminationConditionFactory } from './profiling/manualTerminationCondition';
import { BreakpointTerminationConditionFactory } from './profiling/breakpointTerminationCondition';

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
