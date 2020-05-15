/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { ITerminationConditionFactory, ITerminationCondition } from './terminationCondition';
import * as nls from 'vscode-nls';
import { injectable } from 'inversify';

const localize = nls.loadMessageBundle();

@injectable()
export class ManualTerminationConditionFactory implements ITerminationConditionFactory {
  public readonly sortOrder = 0;
  public readonly id = 'manual';
  public readonly label = localize('profile.termination.duration.label', 'Manual');
  public readonly description = localize(
    'profile.termination.duration.description',
    'Run until manually stopped',
  );

  public async onPick() {
    return new ManualTerminationCondition();
  }
}

export class ManualTerminationCondition implements ITerminationCondition {
  public dispose() {
    // no-op
  }
}
