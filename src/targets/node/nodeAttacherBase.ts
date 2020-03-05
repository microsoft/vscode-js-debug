/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { AnyNodeConfiguration } from '../../configuration';
import { NodeLauncherBase, IRunData, IProcessTelemetry } from './nodeLauncherBase';
import { IProgram } from './program';
import Cdp from '../../cdp/api';
import { INodeTargetLifecycleHooks } from './nodeTarget';
import { IDisposable } from '../../common/disposable';
import { LogTag } from '../../common/logging';
import { delay } from '../../common/promiseUtil';
import { injectable } from 'inversify';

/**
 * Base class that implements common matters for attachment.
 */
@injectable()
export abstract class NodeAttacherBase<T extends AnyNodeConfiguration> extends NodeLauncherBase<T> {
  /**
   * Tracker for whether we're waiting to break and instrument into the main
   * process. This is used to avoid instrumenting unecessarily into subsequent
   * children.
   */
  private capturedEntryProgram?: IProgram;

  /**
   * @inheritdoc
   */
  protected createLifecycle(cdp: Cdp.Api, run: IRunData<T>): INodeTargetLifecycleHooks {
    if (this.program === this.capturedEntryProgram) {
      return {};
    }

    let toDispose: Promise<ReadonlyArray<IDisposable>> = Promise.resolve([]);
    this.capturedEntryProgram = this.program;

    return {
      initialized: async () => {
        toDispose = this.onFirstInitialize(cdp, run);
        await toDispose;
        return undefined;
      },
      close: async () => {
        (await toDispose).forEach(d => d.dispose());
      },
    };
  }

  /**
   * Called the first time, for each program, we get an attachment. Can
   * return disposables to clean up when the run finishes.
   */
  protected async onFirstInitialize(
    cdp: Cdp.Api,
    run: IRunData<T>,
  ): Promise<ReadonlyArray<IDisposable>> {
    await this.gatherTelemetry(cdp, run);
    return [];
  }

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

    if (!telemetry) {
      this.logger.error(LogTag.RuntimeTarget, 'Undefined result getting telemetry');
      return;
    }

    if (telemetry.exceptionDetails) {
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
