/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { injectable } from 'inversify';
import { AnyNodeConfiguration } from '../../configuration';
import { NodeLauncherBase } from './nodeLauncherBase';

/**
 * Base class that implements common matters for attachment.
 */
@injectable()
export abstract class NodeAttacherBase<
  T extends AnyNodeConfiguration,
> extends NodeLauncherBase<T> {}
