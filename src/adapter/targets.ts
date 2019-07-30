// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Thread, ExecutionContext } from "./threads";

export interface Target {
  id: string;
  name: string;
  type: string;
  thread?: Thread;
  executionContext?: ExecutionContext;
  parent?: Target;
  children: Target[];
  stop?: () => void;
  restart?: () => void;
}
