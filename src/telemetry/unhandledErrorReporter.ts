// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { extractErrorDetails, RawTelemetryReporter } from './telemetryReporter';

type ExceptionType = 'uncaughtException' | 'unhandledRejection';

export function installUnhandledErrorReporter(telemetryReporter: RawTelemetryReporter): void {
  process.addListener('uncaughtException', (exception: unknown) => {
    reportErrorTelemetry(telemetryReporter, exception, 'uncaughtException');

    // TODO: Print this to the log
    console.error(`******** Unhandled error in debug adapter: ${safeGetErrDetails(exception)}`);
  });

  process.addListener('unhandledRejection', (rejection: unknown) => {
    reportErrorTelemetry(telemetryReporter, rejection, 'unhandledRejection');

    // TODO: Print this to the log
    console.error(`******** Unhandled error in debug adapter - Unhandled promise rejection: ${safeGetErrDetails(rejection)}`);
  });

}

function reportErrorTelemetry(telemetryReporter: RawTelemetryReporter, err: unknown, exceptionType: ExceptionType): void {
  const properties = { ...extractErrorDetails(err), successful: 'false', exceptionType };

  telemetryReporter.report('error', properties);
}

function safeGetErrDetails(err: unknown): string {
  let errMsg: string;

  try {
    const possibleStack = (err && (<Error>err).stack);
    errMsg = possibleStack ? possibleStack : JSON.stringify(err);
  } catch (e) {
    errMsg = 'Error while handling previous error: ' + e.stack;
  }

  return errMsg;
}
