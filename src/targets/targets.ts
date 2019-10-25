// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import Cdp from '../cdp/api';
import { Disposable, Event } from '../common/events';
import { InlineScriptOffset, ISourcePathResolver } from '../common/sourcePathResolver';
import { AnyLaunchConfiguration } from '../configuration';
import Dap from '../dap/api';

/**
 * A generic running process that can be debugged. We may have a target before
 * we start debugging, until we call `attach()` to
 * actually get a debug adapter API.
 */
export interface Target {
  id(): string;
  name(): string;
  onNameChanged: Event<void>;
  fileName(): string | undefined;
  type(): string;
  parent(): Target | undefined;
  children(): Target[];
  canStop(): boolean;
  stop(): void;
  canRestart(): boolean;
  restart(): void;
  canAttach(): boolean;
  attach(): Promise<Cdp.Api | undefined>;
  canDetach(): boolean;
  detach(): Promise<void>;
  targetOrigin(): any;
  /**
   * Lifecycle callback invoked after attaching and the target's events are
   * wired into the debug adapter.
   */
  afterBind(): Promise<void>;

  /**
   * Handler triggered on a breakpoint. If this returns true, the UI will be
   * continued and no breakpoint will be shown to the user.
   */
  onPaused(event: Cdp.Debugger.PausedEvent): Promise<boolean>;

  initialize(): Promise<void>;
  waitingForDebugger(): boolean;
  supportsCustomBreakpoints(): boolean;
  shouldCheckContentHash(): boolean;
  defaultScriptOffset(): InlineScriptOffset | undefined;
  scriptUrlToUrl(url: string): string;
  sourcePathResolver(): ISourcePathResolver;
  executionContextName(context: Cdp.Runtime.ExecutionContextDescription): string;
  blackboxPattern(): string | undefined;
}

export interface ILaunchContext {
  dap: Dap.Api;
  targetOrigin: any;
}

export interface LaunchResult {
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
}

export interface Launcher extends Disposable {
  launch(params: AnyLaunchConfiguration, context: ILaunchContext): Promise<LaunchResult>;
  terminate(): Promise<void>;
  disconnect(): Promise<void>;
  restart(): Promise<void>;
  onTargetListChanged: Event<void>;
  onTerminated: Event<IStopMetadata>;
  targetList(): Target[];
}
