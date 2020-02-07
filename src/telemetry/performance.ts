/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { LogTag, ILogger } from '../common/logging';

/**
 * Measures and logs the performance of decorated functions.
 */
export const logPerf = async <T>(
  logger: ILogger,
  name: string,
  fn: () => T | Promise<T>,
  metadata: object = {},
): Promise<T> => {
  const start = Date.now();
  try {
    return await fn();
  } finally {
    logger.verbose(LogTag.PerfFunction, '', {
      method: name,
      duration: Date.now() - start,
      ...metadata,
    });
  }
};
