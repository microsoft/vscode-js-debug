// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import Cdp from "../cdp/api";
import { SourcePathResolver, InlineScriptOffset } from "./sources";

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
