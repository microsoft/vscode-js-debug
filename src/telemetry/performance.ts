/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { logger } from '../common/logging/logger';
import { LogTag } from '../common/logging';

/**
 * Measures and logs the performance of decorated functions.
 */
export const logPerf = <T extends {}>(addMetadata?: (inst: T) => object) => (
  target: T,
  property: string,
  descriptor: PropertyDescriptor,
) => {
  const wrapped = descriptor.value as (...args: unknown[]) => unknown;
  const name = `${target.constructor.name}.${property}`;

  descriptor.value = function(this: T, ...args: unknown[]) {
    const start = Date.now();
    const result = wrapped.apply(this, args);
    const log = () =>
      logger.verbose(LogTag.PerfFunction, '', {
        method: name,
        duration: Date.now() - start,
        ...addMetadata?.(this),
      });

    if (result instanceof Promise) {
      return result.finally(log);
    }

    log();
    return result;
  };
};
