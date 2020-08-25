/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import Dap from '../../dap/api';
import { Thread } from '../threads';

export interface IConsoleMessage {
  toDap(thread: Thread): Promise<Dap.OutputEventParams> | Dap.OutputEventParams;
}

export class ClearMessage implements IConsoleMessage {
  /**
   * @inheritdoc
   */
  public toDap(): Dap.OutputEventParams {
    return {
      category: 'console',
      output: '\x1b[2J',
    };
  }
}

export class EndGroupMessage implements IConsoleMessage {
  /**
   * @inheritdoc
   */
  public toDap(): Dap.OutputEventParams {
    return { category: 'stdout', output: '', group: 'end' };
  }
}
