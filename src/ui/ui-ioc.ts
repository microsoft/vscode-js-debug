/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { Container } from 'inversify';
import { IExtensionContribution, trackDispose } from '../ioc-extras';
import { CascadeTerminationTracker } from './cascadeTerminateTracker';
import {
  allConfigurationProviders,
  allConfigurationResolvers,
  IDebugConfigurationProvider,
  IDebugConfigurationResolver,
} from './configuration';
import { DebugLinkUi } from './debugLinkUI';
import { DebugSessionTracker } from './debugSessionTracker';
import { DiagnosticsUI } from './diagnosticsUI';
import { DisableSourceMapUI } from './disableSourceMapUI';
import { EdgeDevToolOpener } from './edgeDevToolOpener';
import { ExcludedCallersUI } from './excludedCallersUI';
import { ILinkedBreakpointLocation } from './linkedBreakpointLocation';
import { LinkedBreakpointLocationUI } from './linkedBreakpointLocationUI';
import { LongPredictionUI } from './longPredictionUI';
import { JsDebugPortAttributesProvider } from './portAttributesProvider';
import { PrettyPrintUI } from './prettyPrint';
import { BreakpointTerminationConditionFactory } from './profiling/breakpointTerminationCondition';
import { DurationTerminationConditionFactory } from './profiling/durationTerminationCondition';
import { ManualTerminationConditionFactory } from './profiling/manualTerminationCondition';
import { ITerminationConditionFactory } from './profiling/terminationCondition';
import { UiProfileManager } from './profiling/uiProfileManager';
import { StartDebugingAndStopOnEntry } from './startDebuggingAndStopOnEntry';
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

  container.bind(IExtensionContribution).to(LongPredictionUI).inSingletonScope();
  container.bind(IExtensionContribution).to(DebugLinkUi).inSingletonScope();
  container.bind(IExtensionContribution).to(CascadeTerminationTracker).inSingletonScope();
  container.bind(IExtensionContribution).to(DisableSourceMapUI).inSingletonScope();
  container.bind(IExtensionContribution).to(DiagnosticsUI).inSingletonScope();
  container.bind(IExtensionContribution).to(StartDebugingAndStopOnEntry).inSingletonScope();
  container.bind(IExtensionContribution).to(JsDebugPortAttributesProvider).inSingletonScope();
  container.bind(IExtensionContribution).to(EdgeDevToolOpener).inSingletonScope();
  container.bind(IExtensionContribution).to(ExcludedCallersUI).inSingletonScope();
  container.bind(IExtensionContribution).to(PrettyPrintUI).inSingletonScope();
  container.bind(ILinkedBreakpointLocation).to(LinkedBreakpointLocationUI).inSingletonScope();
  container.bind(DebugSessionTracker).toSelf().inSingletonScope().onActivation(trackDispose);
  container.bind(UiProfileManager).toSelf().inSingletonScope().onActivation(trackDispose);
  container.bind(TerminalLinkHandler).toSelf().inSingletonScope();
  container.bind(DisableSourceMapUI).toSelf().inSingletonScope();

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
