/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as path from 'path';
import { IDisposable } from '../common/disposable';
import { ILogger, LogTag } from '../common/logging';
import { ITelemetryReporter } from './telemetryReporter';

export const enum ErrorType {
  Exception = 'uncaughtException',
  Rejection = 'unhandledRejection',
}

export function installUnhandledErrorReporter(
  logger: ILogger,
  telemetryReporter: ITelemetryReporter,
  isVsCode?: boolean,
): IDisposable {
  const exceptionListener = onUncaughtError(
    logger,
    telemetryReporter,
    ErrorType.Exception,
    isVsCode,
  );
  const rejectionListener = onUncaughtError(
    logger,
    telemetryReporter,
    ErrorType.Rejection,
    isVsCode,
  );

  process.addListener('uncaughtException', exceptionListener);
  process.addListener('unhandledRejection', rejectionListener);

  return {
    dispose: () => {
      process.removeListener('uncaughtException', exceptionListener);
      process.removeListener('unhandledRejection', rejectionListener);
    },
  };
}

export const onUncaughtError =
  (logger: ILogger, telemetryReporter: ITelemetryReporter, src: ErrorType, isVsCode = true) =>
  (error: unknown) => {
    if (!shouldReportThisError(error)) {
      return;
    }

    telemetryReporter.report('error', {
      '!error': error,
      error: isVsCode ? undefined : error,
      exceptionType: src,
    });
    logger.error(LogTag.RuntimeException, 'Unhandled error in debug adapter', error);
  };

const isErrorObjectLike = (err: unknown): err is Error =>
  typeof err === 'object' && !!err && 'stack' in err;

const debugAdapterFolder = path.dirname(path.dirname(path.dirname(__dirname)));

function shouldReportThisError(error: unknown): boolean {
  // In VS Code, this debug adapter runs inside the extension host process, so we could capture
  // errors from other pieces of software here. We check to make sure this is our error before reporting it
  return (
    !shouldFilterErrorsReportedToTelemetry
    || (isErrorObjectLike(error) && !!error.stack?.includes(debugAdapterFolder))
  );
}

let shouldFilterErrorsReportedToTelemetry = false;
export function filterErrorsReportedToTelemetry(): void {
  shouldFilterErrorsReportedToTelemetry = true;
}
