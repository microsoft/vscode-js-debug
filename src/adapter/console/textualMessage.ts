/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import Cdp from '../../cdp/api';
import { once } from '../../common/objUtils';
import { StackTraceParser } from '../../common/stackTraceParser';
import Dap from '../../dap/api';
import { formatMessage } from '../messageFormat';
import { messageFormatters, previewAsObject } from '../objectPreview';
import { AnyObject } from '../objectPreview/betterTypes';
import { IUiLocation } from '../source';
import { StackFrame, StackTrace } from '../stackTrace';
import { Thread } from '../threads';
import { IConsoleMessage } from './consoleMessage';

export abstract class TextualMessage<T extends { stackTrace?: Cdp.Runtime.StackTrace }>
  implements IConsoleMessage
{
  protected readonly stackTrace = once((thread: Thread) =>
    this.event.stackTrace ? StackTrace.fromRuntime(thread, this.event.stackTrace) : undefined
  );

  constructor(protected readonly event: T) {}

  /**
   * Returns the DAP representation of the console message.
   */
  public abstract toDap(thread: Thread): Promise<Dap.OutputEventParams> | Dap.OutputEventParams;

  /**
   * Gets the UI location where the message was logged.
   */
  protected readonly getUiLocation = once(async (thread: Thread) => {
    const stackTrace = this.stackTrace(thread);
    if (!stackTrace) {
      return;
    }

    let firstExistingLocation: IUiLocation | undefined;
    for (const frame of stackTrace.frames) {
      if (!(frame instanceof StackFrame)) {
        continue;
      }

      const uiLocation = await frame.uiLocation();
      if (!uiLocation) {
        continue;
      }

      if (!firstExistingLocation) {
        firstExistingLocation = uiLocation;
      }

      if (uiLocation.source.blackboxed()) {
        continue;
      }

      return {
        source: await uiLocation.source.toDap(),
        line: uiLocation.lineNumber,
        column: uiLocation.columnNumber,
      };
    }

    // if all the stack is blackboxed, fall back to the original location
    if (firstExistingLocation) {
      return {
        source: await firstExistingLocation.source.toDap(),
        line: firstExistingLocation.lineNumber,
        column: firstExistingLocation.columnNumber,
      };
    }
  });

  /**
   * Default message string formatter. Tries to create a simple string, and
   * but if it can't it'll return a variable reference.
   *
   * Intentionally not async-await as it's a hot path in console logging.
   */
  protected formatDefaultString(
    thread: Thread,
    args: ReadonlyArray<Cdp.Runtime.RemoteObject>,
    includeStackInVariables = false,
  ) {
    const useMessageFormat = args.length > 1 && args[0].type === 'string';
    const formatResult = useMessageFormat
      ? formatMessage(args[0].value, args.slice(1) as AnyObject[], messageFormatters)
      : formatMessage('', args as AnyObject[], messageFormatters);

    const output = formatResult.result + '\n';

    if (formatResult.usedAllSubs && !args.some(previewAsObject)) {
      return { output };
    } else {
      return this.formatComplexStringOutput(thread, output, args, includeStackInVariables);
    }
  }

  private async formatComplexStringOutput(
    thread: Thread,
    output: string,
    args: ReadonlyArray<Cdp.Runtime.RemoteObject>,
    includeStackInVariables: boolean,
  ) {
    if (args.some(a => a.subtype === 'error') || StackTraceParser.isStackLike(output)) {
      await this.getUiLocation(thread); // ensure the source is loaded before decoding stack
      output = await thread.replacePathsInStackTrace(output);
      includeStackInVariables = true;
    }

    const outputVar = thread.replVariables.createVariableForOutput(
      output,
      args,
      includeStackInVariables ? this.stackTrace(thread) : undefined,
    );

    return { output, variablesReference: outputVar.id };
  }
}

export class AssertMessage extends TextualMessage<Cdp.Runtime.ConsoleAPICalledEvent> {
  /**
   * @override
   */
  public async toDap(thread: Thread): Promise<Dap.OutputEventParams> {
    if (this.event.args[0]?.value === 'console.assert') {
      this.event.args[0].value = l10n.t('Assertion failed');
    }

    return {
      category: 'stderr',
      ...(await this.formatDefaultString(thread, this.event.args, /* includeStack= */ true)),
      ...(await this.getUiLocation(thread)),
    };
  }
}

class DefaultMessage extends TextualMessage<Cdp.Runtime.ConsoleAPICalledEvent> {
  constructor(
    event: Cdp.Runtime.ConsoleAPICalledEvent,
    private readonly includeStack: boolean,
    private readonly category: Required<Dap.OutputEventParams['category']>,
  ) {
    super(event);
  }
  /**
   * @override
   */
  public async toDap(thread: Thread): Promise<Dap.OutputEventParams> {
    return {
      category: this.category,
      ...(await this.formatDefaultString(thread, this.event.args, this.includeStack)),
      ...(await this.getUiLocation(thread)),
    };
  }
}

export class LogMessage extends DefaultMessage {
  constructor(event: Cdp.Runtime.ConsoleAPICalledEvent) {
    super(event, false, 'stdout');
  }
}

export class TraceMessage extends DefaultMessage {
  constructor(event: Cdp.Runtime.ConsoleAPICalledEvent) {
    super(event, true, 'stdout');
  }
}

export class WarningMessage extends DefaultMessage {
  constructor(event: Cdp.Runtime.ConsoleAPICalledEvent) {
    super(event, true, 'stderr');
  }
}

export class ErrorMessage extends DefaultMessage {
  constructor(event: Cdp.Runtime.ConsoleAPICalledEvent) {
    super(event, true, 'stderr');
  }
}

export class StartGroupMessage extends TextualMessage<Cdp.Runtime.ConsoleAPICalledEvent> {
  /**
   * @override
   */
  public async toDap(thread: Thread): Promise<Dap.OutputEventParams> {
    return {
      category: 'stdout',
      group: this.event.type === 'startGroupCollapsed' ? 'startCollapsed' : 'start',
      ...(await this.formatDefaultString(thread, this.event.args)),
      ...(await this.getUiLocation(thread)),
    };
  }
}

export class TableMessage extends DefaultMessage {
  constructor(event: Cdp.Runtime.ConsoleAPICalledEvent) {
    super(event, false, 'stdout');
  }

  /**
   * @override
   */
  public async toDap(thread: Thread): Promise<Dap.OutputEventParams> {
    if (this.event.args[0]?.preview) {
      return {
        category: 'stdout',
        output: '',
        variablesReference: thread.replVariables.createVariableForOutput(
          '',
          this.event.args,
          undefined,
          this.event.type,
        ).id,
        ...(await this.getUiLocation(thread)),
      };
    }

    return super.toDap(thread);
  }
}
