// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import Cdp from '../cdp/api';
import { Event, Disposable } from 'vscode';
import { InlineScriptOffset, SourcePathResolver } from '../common/sourcePathResolver';
import Dap from '../dap/api';

export interface Target {
  id(): string;
  name(): string;
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

  waitingForDebugger(): boolean;
  supportsCustomBreakpoints(): boolean;
  defaultScriptOffset(): InlineScriptOffset | undefined;
  scriptUrlToUrl(url: string): string;
  sourcePathResolver(): SourcePathResolver;
  executionContextName(context: Cdp.Runtime.ExecutionContextDescription): string;
}

export interface Launcher extends Disposable {
  launch(params: any): Promise<void>;
  terminate(): Promise<void>;
  disconnect(): Promise<void>;
  restart(): Promise<void>;
  onTargetListChanged: Event<void>;
  onTerminated: Event<void>;
  targetList(): Target[];
  predictBreakpoints(params: Dap.SetBreakpointsParams): Promise<void>;
}
