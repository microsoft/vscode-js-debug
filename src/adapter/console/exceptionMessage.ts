/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import Cdp from '../../cdp/api';
import { once } from '../../common/objUtils';
import { StackTraceParser } from '../../common/stackTraceParser';
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
      return StackTrace.fromRuntime(thread, this.event.stackTrace);
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
      message = `Uncaught ${this.event.exception?.className ?? 'Error'} ` + message;
    }

    const stackTrace = this.stackTrace(thread);
    const args = this.event.exception && !preview.stackTrace ? [this.event.exception] : [];

    // If there is a stacktrace in the exception message, beautify its paths.
    // If there isn't (and there isn't always) then add one.
    if (StackTraceParser.isStackLike(message)) {
      message = await thread.replacePathsInStackTrace(message);
    } else if (stackTrace) {
      message += '\n' + (await stackTrace.formatAsNative());
    }

    return {
      category: 'stderr',
      output: message,
      variablesReference: stackTrace || args.length
        ? thread.replVariables.createVariableForOutput(message, args, stackTrace).id
        : undefined,
      ...(await this.getUiLocation(thread)),
    };
  }
}
