/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import { injectable } from 'inversify';
import * as vscode from 'vscode';
import { DisposableList } from '../../common/disposable';
import { ITerminationCondition, ITerminationConditionFactory } from './terminationCondition';
import { Category, UiProfileSession } from './uiProfileSession';

@injectable()
export class DurationTerminationConditionFactory implements ITerminationConditionFactory {
  private lastDuration?: number;

  public readonly sortOrder = 1;
  public readonly id = 'duration';
  public readonly label = l10n.t('Duration');
  public readonly description = l10n.t('Run for a specific amount of time');

  public async onPick(_session: vscode.DebugSession, duration?: number) {
    if (duration) {
      return new DurationTerminationCondition(duration * 1000);
    }

    const input = vscode.window.createInputBox();
    input.title = l10n.t('Duration of Profile');
    input.placeholder = l10n.t('Profile duration in seconds, e.g "5"');

    if (this.lastDuration) {
      input.value = String(this.lastDuration);
    }

    input.onDidChangeValue(value => {
      if (!/^[0-9]+$/.test(value)) {
        input.validationMessage = l10n.t('Please enter a number');
      } else if (Number(value) < 1) {
        input.validationMessage = l10n.t('Please enter a number greater than 1');
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

      input.onDidHide(() => resolve(undefined));
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
