/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { inject, injectable } from 'inversify';
import Cdp from '../../cdp/api';
import Dap from '../../dap/api';
import { ITarget } from '../../targets/targets';
import { BrowserPerformanceProvider } from './browserPerformanceProvider';
import { NodePerformanceProvider } from './nodePerformanceProvider';

export interface IPerformanceProvider {
  /**
   * Registers the performance provider to serve the DAP API.
   */
  retrieve(cdp: Cdp.Api): Promise<Dap.GetPerformanceResult>;
}

export const IPerformanceProvider = Symbol('IPerformanceProvider');

@injectable()
export class PerformanceProviderFactory {
  constructor(@inject(ITarget) private readonly target: ITarget) {}

  public create() {
    return this.target.type() === 'node'
      ? new NodePerformanceProvider()
      : new BrowserPerformanceProvider();
  }
}
