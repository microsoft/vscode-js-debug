/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { CancellationToken } from 'vscode';
import Cdp from '../cdp/api';
import { IDisposable, IEvent } from '../common/events';
import { ILogger } from '../common/logging';
import { ISourcePathResolver } from '../common/sourcePathResolver';
import { AnyLaunchConfiguration } from '../configuration';
import Dap from '../dap/api';
import { ITelemetryReporter } from '../telemetry/telemetryReporter';
import { ITargetOrigin } from './targetOrigin';

export const ITarget = Symbol('ITarget');

/**
 * A generic running process that can be debugged. We may have a target before
 * we start debugging, until we call `attach()` to
 * actually get a debug adapter API.
 */
export interface ITarget {
  /**
   * Launch configuration for the target. This is used to inject into the IOC
   * in cases where a target's configuration is different than its parent's
   * (e.g. webview debugging in the extension host).
   */
  readonly launchConfig: AnyLaunchConfiguration;

  /**
   * Launcher's target info.
   */
  readonly targetInfo: Readonly<Cdp.Target.TargetInfo>;

  /**
   * Additional launch config information that should be passed into the
   * child debug session's configuration.
   */
  readonly supplementalConfig?: Record<string, unknown>;

  /**
   * Whether the lifecycle for this target can be stopped, restarted, etc.
   * independently of its parents.
   */
  readonly independentLifeycle?: boolean;

  /**
   * Source path resolver, if a custom one should be used for this target.
   */
  readonly sourcePathResolver?: ISourcePathResolver;

  id(): string;
  name(): string;
  onNameChanged: IEvent<void>;
  fileName(): string | undefined;
  type(): string;
  parent(): ITarget | undefined;
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

  /**
   * Called after the launchBlocker resolves. Signals that we're all set up
   * and ready to start debugging the target.
   */
  runIfWaitingForDebugger(): Promise<void>;

  initialize(): Promise<void>;
  waitingForDebugger(): boolean;
  supportsCustomBreakpoints(): boolean;
  supportsXHRBreakpoints(): boolean;
  scriptUrlToUrl(url: string): string;
  executionContextName(context: Cdp.Runtime.ExecutionContextDescription): string;
  entryBreakpoint?: IBreakpointPathAndId | undefined;
  logger: ILogger;
}

export interface IBreakpointPathAndId {
  path: string;
  cdpId: string;
}

export interface ILaunchContext {
  dap: Dap.Api;
  cancellationToken: CancellationToken;
  targetOrigin: ITargetOrigin;
  telemetryReporter: ITelemetryReporter;
}

export interface ILaunchResult {
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
  /**
   * Attempts to launch the given configuration. It should no-op and return a
   * result `{ blockSessionTermination: false }` if it's unable to launch
   * the given configuration, or return an error/true value as appropriate.
   */
  launch(params: AnyLaunchConfiguration, context: ILaunchContext): Promise<ILaunchResult>;

  /**
   * Terminates the debugged process. This should be idempotent.
   * @param terminateDebuggee Whether the debugee should be terminated as well.
   * For `launch` type requests, this has no effect, but attach requests should
   * use "stop" logic instead of "disconnect" logic when provided.
   */
  terminate(terminateDebuggee?: boolean): Promise<void>;

  /**
   * Attempts to restart the debugged process. This may no-op for certain
   * debug types, like attach.
   */
  restart(newParams?: AnyLaunchConfiguration): Promise<void>;

  /**
   * Event that fires when targets connect or disconnect.
   */
  onTargetListChanged: IEvent<void>;

  /**
   * List of currently connected debug targets.
   */
  targetList(): ITarget[];

  /**
   * An event that fires when the debug session has ended.
   */
  onTerminated: IEvent<IStopMetadata>;
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
