// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Thread } from "./threads";

export interface Target {
  id: string;
  name: string;
  fileName?: string;
  type: string;
  thread?: Thread;
  children: Target[];
  stop?: () => void;
  restart?: () => void;
  attach?: () => void;
  detach?: () => void;
}
