/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { ResolvingNodeLaunchConfiguration } from '../configuration';

/**
 * Removes and handles any --inspect or --inspect-brk flags from the launch
 * configuration. These aren't needed and don't work with the new debugger.
 */
export function fixInspectFlags(config: ResolvingNodeLaunchConfiguration) {
  if (!config.runtimeArgs) {
    return;
  }

  const resolved: string[] = [];
  for (const arg of config.runtimeArgs) {
    const flags = /^--inspect(-brk)?(=|$)/.exec(arg);
    if (!flags) {
      resolved.push(arg);
    } else if (flags[1]) {
      // --inspect-brk
      config.stopOnEntry = config.stopOnEntry || true;
    } else {
      // simple --inspect, ignored
    }
  }

  config.runtimeArgs = resolved;
}
