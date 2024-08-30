/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { Container } from 'inversify';
import { IDwarfModuleProvider } from '../adapter/dwarf/dwarfModuleProvider';
import { IRequestOptionsProvider } from '../adapter/resourceProvider/requestOptionsProvider';
import { ITerminalLinkProvider } from '../common/terminalLinkProvider';
import { IExtensionContribution, trackDispose, VSCodeApi } from '../ioc-extras';
import { TerminalNodeLauncher } from '../targets/node/terminalNodeLauncher';
import { ILauncher } from '../targets/targets';
import { IExperimentationService } from '../telemetry/experimentationService';
import { VSCodeExperimentationService } from '../telemetry/vscodeExperimentationService';
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
import { DwarfModuleProvider } from './dwarfModuleProviderImpl';
import { EdgeDevToolOpener } from './edgeDevToolOpener';
import { ExcludedCallersUI } from './excludedCallersUI';
import { LaunchJsonCompletions } from './launchJsonCompletions';
import { ILinkedBreakpointLocation } from './linkedBreakpointLocation';
import { LinkedBreakpointLocationUI } from './linkedBreakpointLocationUI';
import { LongPredictionUI } from './longPredictionUI';
import { NetworkTree } from './networkTree';
import { JsDebugPortAttributesProvider } from './portAttributesProvider';
import { PrettyPrintUI } from './prettyPrint';
import { BreakpointTerminationConditionFactory } from './profiling/breakpointTerminationCondition';
import { DurationTerminationConditionFactory } from './profiling/durationTerminationCondition';
import { ManualTerminationConditionFactory } from './profiling/manualTerminationCondition';
import { ITerminationConditionFactory } from './profiling/terminationCondition';
import { UiProfileManager } from './profiling/uiProfileManager';
import { SettingRequestOptionsProvider } from './settingRequestOptionsProvider';
import { SourceSteppingUI } from './sourceSteppingUI';
import { StartDebugingAndStopOnEntry } from './startDebuggingAndStopOnEntry';
import { TerminalLinkHandler } from './terminalLinkHandler';

export const registerUiComponents = (container: Container) => {
  container.bind(VSCodeApi).toConstantValue(require('vscode'));

  allConfigurationResolvers.forEach(cls => {
    container
      .bind(cls as { new(...args: unknown[]): unknown })
      .toSelf()
      .inSingletonScope();
    container.bind(IDebugConfigurationResolver).to(cls);
  });

  allConfigurationProviders.forEach(cls =>
    container.bind(IDebugConfigurationProvider).to(cls).inSingletonScope()
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
  container.bind(IExtensionContribution).to(SourceSteppingUI).inSingletonScope();
  container.bind(IExtensionContribution).to(NetworkTree).inSingletonScope();
  container.bind(IExtensionContribution).to(LaunchJsonCompletions).inSingletonScope().onActivation(
    trackDispose,
  );
  container.bind(ILinkedBreakpointLocation).to(LinkedBreakpointLocationUI).inSingletonScope();
  container.bind(DebugSessionTracker).toSelf().inSingletonScope().onActivation(trackDispose);
  container.bind(UiProfileManager).toSelf().inSingletonScope().onActivation(trackDispose);
  container.bind(DisableSourceMapUI).toSelf().inSingletonScope();
  container.bind(IDwarfModuleProvider).to(DwarfModuleProvider).inSingletonScope();
  container
    .bind(ITerminalLinkProvider)
    .to(TerminalLinkHandler)
    .inSingletonScope()
    .onActivation(trackDispose);

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

export const registerTopLevelSessionComponents = (container: Container) => {
  container.bind(ILauncher).to(TerminalNodeLauncher).onActivation(trackDispose);

  // request options:
  container.bind(IRequestOptionsProvider).to(SettingRequestOptionsProvider).inSingletonScope();

  container.bind(IExperimentationService).to(VSCodeExperimentationService).inSingletonScope();
};
