/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { AnyNodeConfiguration } from '../../configuration';
import { NodeLauncherBase, IRunData, IProcessTelemetry } from './nodeLauncherBase';
import Cdp from '../../cdp/api';
import { LogTag } from '../../common/logging';
import { delay } from '../../common/promiseUtil';
import { injectable } from 'inversify';

/**
 * Base class that implements common matters for attachment.
 */
@injectable()
export abstract class NodeAttacherBase<T extends AnyNodeConfiguration> extends NodeLauncherBase<T> {
  /**
   * Reads telemetry from the process.
   */
  protected async gatherTelemetry(
    cdp: Cdp.Api,
    run: IRunData<T>,
  ): Promise<IProcessTelemetry | void> {
    const telemetry = await cdp.Runtime.evaluate({
      contextId: 1,
      returnByValue: true,
      expression: `({ processId: process.pid, nodeVersion: process.version, architecture: process.arch })`,
    });

    if (!this.program) {
      return; // shut down
    }

    if (telemetry?.exceptionDetails) {
      if (isProcessNotDefined(telemetry.exceptionDetails)) {
        this.logger.info(LogTag.RuntimeTarget, 'Process not yet defined, will retry');
        await delay(10);
        return this.gatherTelemetry(cdp, run);
      }

      this.logger.error(
        LogTag.RuntimeTarget,
        'Error getting telemetry',
        telemetry.exceptionDetails,
      );
      return;
    }

    if (!telemetry || !telemetry.result.value) {
      this.logger.error(LogTag.RuntimeTarget, 'Undefined result getting telemetry');
      return;
    }

    const result = telemetry.result.value as IProcessTelemetry;

    run.context.telemetryReporter.report('nodeRuntime', {
      version: result.nodeVersion,
      arch: result.architecture,
    });
    this.program.gotTelemetery(result);

    return result;
  }
}

const isProcessNotDefined = (exception: Cdp.Runtime.ExceptionDetails) =>
  exception.exception && String(exception.exception.description).includes('process is not defined');
