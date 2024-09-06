/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { injectable } from 'inversify';
import Dap from '../dap/api';

export interface IClientCapabilies {
  value?: Dap.InitializeParams;
}

export const IClientCapabilies = Symbol('IClientCapabilies');

@injectable()
export class ClientCapabilities implements IClientCapabilies {
  value?: Dap.InitializeParams | undefined;
}
