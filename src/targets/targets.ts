/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { CancellationToken } from 'vscode';
import Cdp from '../cdp/api';
import { IDisposable, IEvent } from '../common/events';
import { ISourcePathResolver } from '../common/sourcePathResolver';
import { AnyLaunchConfiguration } from '../configuration';
import Dap from '../dap/api';
import { TelemetryReporter } from '../telemetry/telemetryReporter';
import { ITargetOrigin } from './targetOrigin';

export const ITarget = Symbol('ITarget');

/**
 * A generic running process that can be debugged. We may have a target before
 * we start debugging, until we call `attach()` to
 * actually get a debug adapter API.
 */
export interface ITarget {
  id(): string;
  name(): string;
  onNameChanged: IEvent<void>;
  fileName(): string | undefined;
  type(): string;
  parent(): ITarget | undefined;
  children(): ITarget[];
  canStop(): boolean;
  stop(): void;
  canRestart(): boolean;
  restart(): void;
  canAttach(): boolean;
  attach(): Promise<Cdp.Api | undefined>;
  canDetach(): boolean;
  detach(): Promise<void>;
  targetOrigin(): ITargetOrigin;
  /**
   * Lifecycle callback invoked after attaching and the target's events are
   * wired into the debug adapter.
   */
  afterBind(): Promise<void>;

  initialize(): Promise<void>;
  waitingForDebugger(): boolean;
  supportsCustomBreakpoints(): boolean;
  shouldCheckContentHash(): boolean;
  scriptUrlToUrl(url: string): string;
  sourcePathResolver(): ISourcePathResolver;
  executionContextName(context: Cdp.Runtime.ExecutionContextDescription): string;
}

export interface ILaunchContext {
  dap: Dap.Api;
  cancellationToken: CancellationToken;
  targetOrigin: ITargetOrigin;
  telemetryReporter: TelemetryReporter;
}

export interface ILaunchResult {
  error?: string;
  blockSessionTermination?: boolean;
}

/**
 * Data emitted in the 'stopped' promise.
 */
export interface IStopMetadata {
  /**
   * Numeric close code, non-zero exits are treated as errors.
   */
  code: number;
  /**
   * True if the launcher was intentionally closed by a user.
   */
  killed: boolean;
  /**
   * Any error that occurred.
   */
  error?: Error;

  /**
   * Restart parameters.
   */
  restart?: Dap.AttachParams['__restart'];
}

export const ILauncher = Symbol('ILauncher');

export interface ILauncher extends IDisposable {
  launch(
    params: AnyLaunchConfiguration,
    context: ILaunchContext,
    clientCapabilities: Dap.InitializeParams,
  ): Promise<ILaunchResult>;
  terminate(): Promise<void>;
  disconnect(): Promise<void>;
  restart(): Promise<void>;
  onTargetListChanged: IEvent<void>;
  onTerminated: IEvent<IStopMetadata>;
  targetList(): ITarget[];
}

export interface IWebViewConnectionInfo {
  description: string;
  faviconUrl: string;
  id: string;
  title: string;
  type: string;
  url: string;
  devtoolsActivePort?: string;
}
