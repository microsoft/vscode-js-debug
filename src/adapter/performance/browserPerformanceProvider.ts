/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import Cdp from '../../cdp/api';
import Dap from '../../dap/api';
import { IPerformanceProvider } from '.';

export class BrowserPerformanceProvider implements IPerformanceProvider {
  private readonly didEnable = new WeakSet<Cdp.Api>();

  /**
   * @inheritdoc
   */
  public async retrieve(cdp: Cdp.Api): Promise<Dap.GetPerformanceResult> {
    if (!this.didEnable.has(cdp)) {
      this.didEnable.add(cdp);
      await cdp.Performance.enable({});
    }

    const metrics = await cdp.Performance.getMetrics({});
    if (!metrics) {
      return { error: 'Error in CDP' };
    }

    const obj: Record<string, number> = {};
    for (const metric of metrics.metrics) {
      obj[metric.name] = metric.value;
    }

    return { metrics: obj };
  }
}
