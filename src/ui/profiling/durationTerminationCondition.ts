/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { ITerminationConditionFactory, ITerminationCondition } from './terminationCondition';
import * as nls from 'vscode-nls';
import * as vscode from 'vscode';
import { UiProfileSession, Category } from './uiProfileSession';
import { injectable } from 'inversify';
import { DisposableList } from '../../common/disposable';

const localize = nls.loadMessageBundle();

@injectable()
export class DurationTerminationConditionFactory implements ITerminationConditionFactory {
  private lastDuration?: number;

  public readonly sortOrder = 1;
  public readonly id = 'duration';
  public readonly label = localize('profile.termination.duration.label', 'Duration');
  public readonly description = localize(
    'profile.termination.duration.description',
    'Run for a specific amount of time',
  );

  public async onPick(_session: vscode.DebugSession, duration?: number) {
    if (duration) {
      return new DurationTerminationCondition(duration * 1000);
    }

    const input = vscode.window.createInputBox();
    input.title = localize('profile.termination.duration.inputTitle', 'Duration of Profile');
    input.placeholder = localize(
      'profile.termination.duration.placeholder',
      'Profile duration in seconds, e.g "5"',
    );

    if (this.lastDuration) {
      input.value = String(this.lastDuration);
    }

    input.onDidChangeValue(value => {
      if (!/^[0-9]+$/.test(value)) {
        input.validationMessage = localize(
          'profile.termination.duration.invalidFormat',
          'Please enter a number',
        );
      } else if (Number(value) < 1) {
        input.validationMessage = localize(
          'profile.termination.duration.invalidLength',
          'Please enter a number greater than 1',
        );
      } else {
        input.validationMessage = undefined;
      }
    });

    const condition = await new Promise<DurationTerminationCondition | undefined>(resolve => {
      input.onDidAccept(() => {
        if (input.validationMessage) {
          return resolve(undefined);
        }

        this.lastDuration = Number(input.value);
        resolve(new DurationTerminationCondition(this.lastDuration * 1000));
      });

      input.onDidHide(() => resolve());
      input.show();
    });

    input.dispose();

    return condition;
  }
}

class DurationTerminationCondition implements ITerminationCondition {
  private disposable = new DisposableList();

  constructor(private readonly duration: number) {}

  public attachTo(session: UiProfileSession) {
    const deadline = Date.now() + this.duration;
    const updateTimer = () =>
      session.setStatus(
        Category.TerminationTimer,
        `${Math.round((deadline - Date.now()) / 1000)}s`,
      );
    const stopTimeout = setTimeout(() => session.stop(), this.duration);
    const updateInterval = setInterval(updateTimer, 1000);
    updateTimer();

    this.disposable.callback(() => {
      clearTimeout(stopTimeout);
      clearInterval(updateInterval);
    });
  }

  public dispose() {
    this.disposable.dispose();
  }
}
