/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import Cdp from '../../cdp/api';
import Dap from '../../dap/api';
import { getSourceSuffix } from '../templates';
import { IPerformanceProvider } from '.';

export class NodePerformanceProvider implements IPerformanceProvider {
  /**
   * @inheritdoc
   */
  public async retrieve(cdp: Cdp.Api): Promise<Dap.GetPerformanceResult> {
    const res = await cdp.Runtime.evaluate({
      expression: `({
        memory: process.memoryUsage(),
        cpu: process.cpuUsage(),
        timestamp: Date.now(),
        resourceUsage: process.resourceUsage && process.resourceUsage(),
      })${getSourceSuffix()}`,
      returnByValue: true,
    });

    if (!res) {
      return { error: 'No response from CDP' };
    }

    if (res.exceptionDetails) {
      return { error: res.exceptionDetails.text };
    }

    return { metrics: res.result.value };
  }
}
