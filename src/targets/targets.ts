// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import Cdp from '../cdp/api';
import { Disposable, Event } from '../common/events';
import { InlineScriptOffset, SourcePathResolver } from '../common/sourcePathResolver';
import { CommonLaunchParams } from '../common/commonLaunchParams';
import { ScriptSkipper } from '../adapter/scriptSkipper';

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

  waitingForDebugger(): boolean;
  supportsCustomBreakpoints(): boolean;
  shouldCheckContentHash(): boolean;
  defaultScriptOffset(): InlineScriptOffset | undefined;
  scriptUrlToUrl(url: string): string;
  sourcePathResolver(): SourcePathResolver;
  executionContextName(context: Cdp.Runtime.ExecutionContextDescription): string;
  skipFiles(): ScriptSkipper | undefined;
}

export interface LaunchResult {
  error?: string;
  blockSessionTermination?: boolean;
}

export interface Launcher extends Disposable {
  launch(params: CommonLaunchParams, targetOrigin: any): Promise<LaunchResult>;
  terminate(): Promise<void>;
  disconnect(): Promise<void>;
  restart(): Promise<void>;
  onTargetListChanged: Event<void>;
  onTerminated: Event<void>;
  targetList(): Target[];
}
