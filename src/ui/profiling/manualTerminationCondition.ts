/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { ITerminationConditionFactory, ITerminationCondition } from './terminationCondition';
import * as nls from 'vscode-nls';
import { injectable } from 'inversify';

const localize = nls.loadMessageBundle();

@injectable()
export class ManualTerminationConditionFactory implements ITerminationConditionFactory {
  public readonly label = localize('profile.termination.manual.name', 'Until manually stopped');

  public async onPick() {
    return new ManualTerminationCondition();
  }
}

class ManualTerminationCondition implements ITerminationCondition {
  public attachTo() {
    // no-op
  }

  public dispose() {
    // no-op
  }
}
