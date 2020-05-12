/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import Dap from '../dap/api';
import * as fs from 'fs';
import * as path from 'path';

/******************************************************************************
 * GDPR tooling definitions
 *****************************************************************************/

export interface IPropertyData {
  classification:
    | 'SystemMetaData'
    | 'CallstackOrException'
    | 'CustomerContent'
    | 'EndUserPseudonymizedInformation'
    | 'Unclassified';
  purpose: 'PerformanceAndHealth' | 'FeatureInsight' | 'BusinessInsight';
  endpoint?: string;
  isMeasurement?: boolean;
}

interface IGDPRProperty {
  readonly [name: string]: IPropertyData | undefined | IGDPRProperty;
}

type ClassifiedEvent<T extends IGDPRProperty> = { [K in keyof T]?: unknown };

type StrictPropertyCheck<
  TEvent,
  TClassifiedEvent,
  TError
> = keyof TEvent extends keyof TClassifiedEvent
  ? keyof TClassifiedEvent extends keyof TEvent
    ? TEvent
    : TError
  : TError;

/******************************************************************************
 * Classifications
 *****************************************************************************/

export interface IGlobalProperties {
  version: string;
}

interface IGlobalClassification {
  nodeVersion: { classification: 'SystemMetaData'; purpose: 'FeatureInsight' };
  browser: { classification: 'SystemMetaData'; purpose: 'FeatureInsight' };
  jsDebugCommitId: { classification: 'SystemMetaData'; purpose: 'FeatureInsight' };
}

export interface IGlobalMetrics {
  nodeVersion?: string;
  browser?: string;
  jsDebugCommitId?: string;
}

interface IRPCOperationClassification
  extends IDAPOperationClassification,
    ICDPOperationClassification {
  [key: string]: {
    classification: 'SystemMetaData' | 'CallstackOrException';
    purpose: 'PerformanceAndHealth';
  };
}

export interface IRPCMetrics {
  operation: string;
  totalTime: number;
  max: number;
  avg: number;
  stddev: number;
  count: number;
  failed: number;
}

export interface IRPCMetricsAndErrorsMap {
  [key: string]: IRPCMetrics | Error[] | string | undefined;
}

export interface IRPCOperation {
  performance: ReadonlyArray<IRPCMetrics>;
}

interface IErrorClassification {
  exceptionType: { classification: 'CallstackOrException'; purpose: 'PerformanceAndHealth' };
  '!error': { classification: 'CallstackOrException'; purpose: 'PerformanceAndHealth' };
}

export interface IErrorMetrics {
  exceptionType: 'uncaughtException' | 'unhandledRejection';
  '!error': unknown;
}

interface IBreakpointClassification {
  set: { classification: 'SystemMetaData'; purpose: 'FeatureInsight' };
  verified: { classification: 'SystemMetaData'; purpose: 'FeatureInsight' };
  hit: { classification: 'SystemMetaData'; purpose: 'FeatureInsight' };
}

export interface IBreakpointMetrics {
  set: number;
  verified: number;
  hit: number;
}

interface IBrowserVersionClassification {
  targetCRDPVersion: { classification: 'SystemMetaData'; purpose: 'FeatureInsight' };
  targetRevision: { classification: 'SystemMetaData'; purpose: 'FeatureInsight' };
  targetUserAgent: { classification: 'SystemMetaData'; purpose: 'FeatureInsight' };
  targetV8: { classification: 'SystemMetaData'; purpose: 'FeatureInsight' };
  targetProject: { classification: 'SystemMetaData'; purpose: 'FeatureInsight' };
  targetVersion: { classification: 'SystemMetaData'; purpose: 'FeatureInsight' };
  targetProduct: { classification: 'SystemMetaData'; purpose: 'FeatureInsight' };
}

export interface IBrowserVersionMetrics {
  targetCRDPVersion: string;
  targetRevision: string;
  targetUserAgent: string;
  targetV8: string;
  targetProject: string;
  targetVersion: string;
  targetProduct: string;
}

interface INodeRuntimeClassification {
  version: { classification: 'SystemMetaData'; purpose: 'FeatureInsight' };
  arch: { classification: 'SystemMetaData'; purpose: 'FeatureInsight' };
}

export interface INodeRuntimeMetrics {
  version: string;
  arch: string;
}

interface ILaunchClassification {
  type: { classification: 'SystemMetaData'; purpose: 'FeatureInsight' };
  request: { classification: 'SystemMetaData'; purpose: 'FeatureInsight' };
  parameters: { classification: 'SystemMetaData'; purpose: 'FeatureInsight' };
  nodeVersion: { classification: 'SystemMetaData'; purpose: 'FeatureInsight' };
  adapterVersion: { classification: 'SystemMetaData'; purpose: 'FeatureInsight' };
  os: { classification: 'SystemMetaData'; purpose: 'FeatureInsight' };
}

export interface ILaunchMetrics {
  type: string;
  os: string;
  nodeVersion: string;
  adapterVersion: string;
  request: string;
  parameters: string;
}

/******************************************************************************
 * Implementations
 *****************************************************************************/

/**
 * Creates typed, classified logging functions. Takes a callback that's
 * invoked when any of the logging functions are called.
 */
export const createLoggers = (sendEvent: (event: Dap.OutputEventParams) => void) => {
  const globalMetrics: Partial<IGlobalMetrics> = {};
  setJsDebugCommitId(globalMetrics);

  /**
   * Warning! The naming of this method is required to be exactly `publicLog2`
   * for the GDPR tooling to automatically detect.
   */
  function publicLog2<
    E extends ClassifiedEvent<T> = never,
    T extends { [_ in keyof T]: IPropertyData | IGDPRProperty | undefined } = never
  >(
    name: string,
    props: StrictPropertyCheck<
      E,
      ClassifiedEvent<T>,
      'Type of classified event does not match event properties'
    >,
  ) {
    return sendEvent({
      category: 'telemetry',
      output: name,
      data: props,
    });
  }

  const dapOperation = (metrics: IRPCMetricsAndErrorsMap) =>
    publicLog2<
      IGlobalMetrics & IRPCMetricsAndErrorsMap,
      IRPCOperationClassification & IGlobalClassification
    >('js-debug/dap/operation', { ...globalMetrics, ...metrics });

  const cdpOperation = (metrics: IRPCMetricsAndErrorsMap) =>
    publicLog2<
      IGlobalMetrics & IRPCMetricsAndErrorsMap,
      IRPCOperationClassification & IGlobalClassification
    >('js-debug/cdp/operation', { ...globalMetrics, ...metrics });

  const error = (metrics: IErrorMetrics) =>
    publicLog2<IGlobalMetrics & IErrorMetrics, IErrorClassification & IGlobalClassification>(
      'js-debug/error',
      { ...globalMetrics, ...metrics },
    );

  const browserVersion = (metrics: IBrowserVersionMetrics) => {
    globalMetrics.browser =
      (metrics.targetProject || metrics.targetProject) + '/' + metrics.targetVersion;

    publicLog2<
      IGlobalMetrics & IBrowserVersionMetrics,
      IBrowserVersionClassification & IGlobalClassification
    >('js-debug/browserVersion', { ...globalMetrics, ...metrics });
  };

  const breakpointStats = (metrics: IBreakpointMetrics) =>
    publicLog2<
      IGlobalMetrics & IBreakpointMetrics,
      IBreakpointClassification & IGlobalClassification
    >('js-debug/breakpointStats', { ...globalMetrics, ...metrics });

  const nodeRuntime = (metrics: INodeRuntimeMetrics) => {
    globalMetrics.nodeVersion = metrics.version;

    publicLog2<
      IGlobalMetrics & INodeRuntimeMetrics,
      INodeRuntimeClassification & IGlobalClassification
    >('js-debug/nodeRuntime', { ...globalMetrics, ...metrics });
  };

  const launch = (metrics: Omit<ILaunchMetrics, 'parameters'> & { parameters: object }) => {
    publicLog2<IGlobalMetrics & ILaunchMetrics, ILaunchClassification & IGlobalClassification>(
      'js-debug/launch',
      { ...globalMetrics, ...metrics, parameters: JSON.stringify(metrics.parameters) },
    );
  };

  /**
   * VS contains a file .gitcommit with the exact commit version being shipped.
   * We want to be able to easily track which commit telemetry came from, specially to translate error call stacks
   */
  function setJsDebugCommitId(globalMetrics: IGlobalMetrics) {
    try {
      const filePath = path.resolve(path.dirname(__filename), '..', '..', '.gitcommit');
      globalMetrics.jsDebugCommitId = fs.readFileSync(filePath, 'utf8');
    } catch {
      // We don't do anything if we don't have the file, or can't read it
    }
  }

  return {
    breakpointStats,
    browserVersion,
    cdpOperation,
    dapOperation,
    error,
    launch,
    nodeRuntime,
  };
};

/**
 * Type for all logging functions this extension has.
 */
export type LogFunctions = ReturnType<typeof createLoggers>;
