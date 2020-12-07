/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import Cdp from '../../cdp/api';
import { once } from '../../common/objUtils';
import Dap from '../../dap/api';
import { previewException } from '../objectPreview';
import { StackTrace } from '../stackTrace';
import { Thread } from '../threads';
import { TextualMessage } from './textualMessage';

/**
 * Special console message formed from an unhandled exception.
 */
export class ExceptionMessage extends TextualMessage<Cdp.Runtime.ExceptionDetails> {
  /**
   * @override
   */
  protected readonly stackTrace = once((thread: Thread) => {
    if (this.event.stackTrace) {
      return StackTrace.fromRuntime(thread, this.event.stackTrace, 2);
    }

    if (this.event.scriptId) {
      // script parsed errors will not have a stacktrace
      return StackTrace.fromRuntime(thread, {
        callFrames: [
          {
            functionName: '(program)',
            lineNumber: this.event.lineNumber,
            columnNumber: this.event.columnNumber,
            scriptId: this.event.scriptId,
            url: this.event.url || '',
          },
        ],
      });
    }

    return undefined;
  });

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
