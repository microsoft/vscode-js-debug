/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { ResolvingNodeLaunchConfiguration } from '../configuration';

/**
 * Removes any --inspect-brk flags from the launch configuration and sets
 * stopOnEntry instead, otherwise we break inside the bootloader.
 */
export function fixInspectFlags(config: ResolvingNodeLaunchConfiguration) {
  if (!config.runtimeArgs) {
    return;
  }

  const resolved: string[] = [];
  for (const arg of config.runtimeArgs) {
    if (/^--inspect-brk(=|$)/.test(arg)) {
      config.stopOnEntry = config.stopOnEntry || true;
    } else {
      resolved.push(arg);
    }
  }

  config.runtimeArgs = resolved;
}
