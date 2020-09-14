/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { IPerformanceProvider } from '.';
import Cdp from '../../cdp/api';
import Dap from '../../dap/api';
import { getSourceSuffix } from '../templates';

export class NodePerformanceProvider implements IPerformanceProvider {
  /**
   * @inheritdoc
   */
  public async retrieve(cdp: Cdp.Api): Promise<Dap.GetPerformanceResult> {
    const res = await cdp.Runtime.evaluate({
      expression: `({ ...process.memoryUsage(), ...process.cpuUsage() })${getSourceSuffix()}`,
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
