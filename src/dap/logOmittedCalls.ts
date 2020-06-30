/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

export const logOmittedCalls = new WeakSet<object>();

/**
 * Omits logging a call when the given object is used as parameters for
 * a method call. This is, at the moment, solely used to prevent logging
 * log output and getting into an feedback loop with the ConsoleLogSink.
 */
export const omitLoggingFor = <T extends object>(obj: T): T => {
  logOmittedCalls.add(obj);
  return obj;
};
