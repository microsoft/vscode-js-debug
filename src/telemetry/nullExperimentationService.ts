/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { injectable } from 'inversify';
import { IExperimentationService, IExperiments } from './experimentationService';

@injectable()
export class NullExperimentationService implements IExperimentationService {
  /**
   * @inheritdoc
   */
  getTreatment<K extends keyof IExperiments>(
    _name: K,
    defaultValue: IExperiments[K],
  ): Promise<IExperiments[K]> {
    return Promise.resolve(defaultValue);
  }
}
