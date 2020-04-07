/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as path from 'path';
import { ITelemetryReporter } from './telemetryReporter';
import { LogTag, ILogger } from '../common/logging';
import { IDisposable } from '../common/disposable';

export function installUnhandledErrorReporter(
  logger: ILogger,
  telemetryReporter: ITelemetryReporter,
): IDisposable {
  const exceptionListener = (exception: unknown) => {
    if (shouldReportThisError(exception)) {
      telemetryReporter.report('error', { error: exception, exceptionType: 'uncaughtException' });
      logger.error(LogTag.RuntimeException, 'Unhandled error in debug adapter', exception);
    }
  };
  const rejectionListener = (rejection: unknown) => {
    if (shouldReportThisError(rejection)) {
      telemetryReporter.report('error', { error: rejection, exceptionType: 'unhandledRejection' });
      logger.error(LogTag.RuntimeException, 'Unhandled promise rejection', rejection);
    }
  };

  process.addListener('uncaughtException', exceptionListener);
  process.addListener('unhandledRejection', rejectionListener);

  return {
    dispose: () => {
      process.removeListener('uncaughtException', exceptionListener);
      process.removeListener('unhandledRejection', rejectionListener);
    },
  };
}

const isErrorObjectLike = (err: unknown): err is Error =>
  typeof err === 'object' && !!err && 'stack' in err;

const debugAdapterFolder = path.dirname(path.dirname(path.dirname(__dirname)));

function shouldReportThisError(error: unknown): boolean {
  // In VS Code, this debug adapter runs inside the extension host process, so we could capture
  // errors from other pieces of software here. We check to make sure this is our error before reporting it
  return (
    !shouldFilterErrorsReportedToTelemetry ||
    (isErrorObjectLike(error) && !!error.stack?.includes(debugAdapterFolder))
  );
}

let shouldFilterErrorsReportedToTelemetry = false;
export function filterErrorsReportedToTelemetry(): void {
  shouldFilterErrorsReportedToTelemetry = true;
}
