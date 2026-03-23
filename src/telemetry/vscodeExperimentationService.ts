/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { inject, injectable, optional } from 'inversify';
import type * as vscode from 'vscode';
import {
  getExperimentationService,
  IExperimentationService,
  TargetPopulation,
} from 'vscode-tas-client';
import { IDisposable } from '../common/disposable';
import { isNightly, packageVersion } from '../configuration';
import { ExtensionContext } from '../ioc-extras';
import { DapTelemetryReporter } from './dapTelemetryReporter';
import {
  IExperimentationService as IJsDebugExpService,
  IExperiments,
} from './experimentationService';
import { ITelemetryReporter } from './telemetryReporter';

@injectable()
export class VSCodeExperimentationService implements IJsDebugExpService, IDisposable {
  private service?: IExperimentationService;

  constructor(
    @inject(ITelemetryReporter) reporter: ITelemetryReporter,
    @optional() @inject(ExtensionContext) context: vscode.ExtensionContext,
  ) {
    // todo: will we ever want experimentation in VS proper?
    if (context && reporter instanceof DapTelemetryReporter) {
      this.service = getExperimentationService(
        'ms-vscode.js-debug',
        packageVersion,
        isNightly ? TargetPopulation.Insiders : TargetPopulation.Public,
        {
          setSharedProperty(name, value) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            reporter.setGlobalMetric(name as any, value);
          },
          postEvent(eventName, properties) {
            reporter.pushOutput({
              category: 'telemetry',
              output: eventName,
              data: properties,
            });
          },
        },
        context.globalState,
      );
    }
  }

  dispose(): void {
    // See microsoft/tas-client#74
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const polling = (this.service as any)?.pollingService;
    polling?.StopPolling();
  }

  /**
   * @inheritdoc
   */
  public async getTreatment<K extends keyof IExperiments>(
    name: K,
    defaultValue: IExperiments[K],
  ): Promise<IExperiments[K]> {
    if (!this.service) {
      return defaultValue;
    }

    try {
      const r = await this.service.getTreatmentVariableAsync('vscode', name, true);
      return r as IExperiments[K];
    } catch (e) {
      return defaultValue;
    }
  }
}
