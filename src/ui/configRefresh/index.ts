/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { AnyLaunchConfiguration } from '../../configuration';

/**
 * Refreshes launch configuration based on the user's current settings.
 */
export interface IConfigRefresher {
  refresh(configuration: AnyLaunchConfiguration): Promise<AnyLaunchConfiguration | undefined>;
}

export const IConfigRefresher = Symbol('IConfigRefresher');
