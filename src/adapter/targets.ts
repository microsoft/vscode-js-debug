// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Thread } from "./threads";
import Cdp from "../cdp/api";
import { SourcePathResolver, InlineScriptOffset } from "./sources";

export interface Target {
  id(): string;
  name(): string;
  fileName(): string | undefined;
  type(): string;
  children(): Target[];
  canStop(): boolean;
  stop(): void;
  canRestart(): boolean;
  restart(): void;
  attach?: () => void;
  detach?: () => void;

  waitingForDebugger(): boolean;
  supportsCustomBreakpoints(): boolean;
  defaultScriptOffset(): InlineScriptOffset | undefined;
  sourcePathResolver(): SourcePathResolver;
  executionContextName(context: Cdp.Runtime.ExecutionContextDescription): string;

  thread(): Thread | undefined;
}
