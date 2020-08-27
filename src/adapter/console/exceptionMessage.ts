/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import Cdp from '../../cdp/api';
import Dap from '../../dap/api';
import { previewException } from '../objectPreview';
import { Thread } from '../threads';
import { TextualMessage } from './textualMessage';

/**
 * Special console message formed from an unhandled exception.
 */
export class ExceptionMessage extends TextualMessage<Cdp.Runtime.ExceptionDetails> {
  /**
   * @override
   */
  public async toDap(thread: Thread): Promise<Dap.OutputEventParams> {
    const preview = this.event.exception ? previewException(this.event.exception) : { title: '' };

    let message = preview.title;
    if (!message.startsWith('Uncaught')) {
      message = 'Uncaught ' + message;
    }

    const stackTrace = this.stackTrace(thread);
    const args = this.event.exception && !preview.stackTrace ? [this.event.exception] : [];

    return {
      category: 'stderr',
      output: message,
      variablesReference:
        stackTrace || args.length
          ? await thread.replVariables.createVariableForOutput(message, args, stackTrace)
          : undefined,
      ...(await this.getUiLocation(thread)),
    };
  }
}
