/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { inject, injectable } from 'inversify';
import Cdp from '../cdp/api';
import { DisposableList } from '../common/disposable';
import { EventEmitter } from '../common/events';
import { disposableTimeout } from '../common/promiseUtil';
import Dap from '../dap/api';
import { IRootDapApi } from '../dap/connection';
import { IExperimentationService } from '../telemetry/experimentationService';
import { ITelemetryReporter } from '../telemetry/telemetryReporter';

const ignoredModulePatterns = /\/node_modules\/|^node\:/;
const consecutiveSessions = 2;
const suggestDelay = 5000;
const minDuration = suggestDelay / 2;

/**
 * Fires an event to indicate to the UI that it should suggest the user open
 * the diagnostic tool. The indicator will be shown when all of the following
 * are true:
 *
 * - At least one breakpoint was set, but no breakpoints bound,
 * - For two consecutive debug sessions,
 * - Where a sourcemap was used for a script outside of the node_modules, or
 *   a remoteRoot is present (since sourcemaps and remote are the cases where
 *   almost all path resolution issues happen)
 */
@injectable()
export class DiagnosticToolSuggester {
  /**
   * Number of sessions that qualify for help. The DiagnosticToolSuggester is
   * a global singleton and we don't care about persistence, so this is fine.
   */
  private static consecutiveQualifyingSessions = 0;

  /**
   * Fired when a disqualifying event happens. This is global, since in a
   * compound launch config many sessions might be launched but only one of
   * them could end up qualifying.
   */
  private static didVerifyEmitter = new EventEmitter<void>();

  /**
   * Whether we recently suggested using the diagnostic tool.
   */
  private static didSuggest = false;

  private readonly disposable = new DisposableList();
  private hadBreakpoint = false;
  private didVerifyBreakpoint = false;
  private hadNonModuleSourcemap = false;
  private startedAt = Date.now();

  private get currentlyQualifying() {
    return this.hadBreakpoint && !this.didVerifyBreakpoint && this.hadNonModuleSourcemap;
  }

  constructor(
    @inject(IRootDapApi) dap: Dap.Api,
    @inject(ITelemetryReporter) private readonly telemetry: ITelemetryReporter,
    @inject(IExperimentationService) private readonly experimentation: IExperimentationService,
  ) {
    this.disposable.push(
      DiagnosticToolSuggester.didVerifyEmitter.event(() => {
        this.didVerifyBreakpoint = true;
      }),
    );

    if (DiagnosticToolSuggester.consecutiveQualifyingSessions >= consecutiveSessions) {
      this.disposable.push(
        disposableTimeout(async () => {
          if (!this.currentlyQualifying) {
            return;
          }

          if (!(await this.experimentation.getTreatment('diagnosticPrompt', true))) {
            return;
          }

          telemetry.report('diagnosticPrompt', { event: 'suggested' });
          DiagnosticToolSuggester.didSuggest = true;
          dap.suggestDiagnosticTool({});
        }, suggestDelay),
      );
    }
  }

  public notifyHadBreakpoint() {
    this.hadBreakpoint = true;
  }

  public notifyVerifiedBreakpoint() {
    if (this.didVerifyBreakpoint) {
      return;
    }

    DiagnosticToolSuggester.didVerifyEmitter.fire();

    if (DiagnosticToolSuggester.didSuggest) {
      DiagnosticToolSuggester.didSuggest = false;
      this.telemetry.report('diagnosticPrompt', { event: 'resolved' });
    }
  }

  /**
   * Attaches the CDP API. Should be called for each
   */
  public attach(cdp: Cdp.Api) {
    if (!this.hadNonModuleSourcemap) {
      const listener = this.disposable.push(
        cdp.Debugger.on('scriptParsed', evt => {
          if (!!evt.sourceMapURL && !ignoredModulePatterns.test(evt.url)) {
            this.hadNonModuleSourcemap = true;
            this.disposable.disposeObject(listener);
          }
        }),
      );
    }
  }

  /**
   * Should be called before the root debug session ends. It'll fire a DAP
   * message to show a notification if appropriate.
   */
  public dispose() {
    if (this.currentlyQualifying && Date.now() - minDuration > this.startedAt) {
      DiagnosticToolSuggester.consecutiveQualifyingSessions++;
    } else {
      DiagnosticToolSuggester.consecutiveQualifyingSessions = 0;
    }

    this.disposable.dispose();
  }
}
