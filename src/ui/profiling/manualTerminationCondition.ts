/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import { injectable } from 'inversify';
import { ITerminationCondition, ITerminationConditionFactory } from './terminationCondition';

@injectable()
export class ManualTerminationConditionFactory implements ITerminationConditionFactory {
  public readonly sortOrder = 0;
  public readonly id = 'manual';
  public readonly label = l10n.t('Manual');
  public readonly description = l10n.t('Run until manually stopped');

  public async onPick() {
    return new ManualTerminationCondition();
  }
}

export class ManualTerminationCondition implements ITerminationCondition {
  public dispose() {
    // no-op
  }
}
