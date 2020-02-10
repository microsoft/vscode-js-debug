/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { INodeLaunchConfiguration } from '../../configuration';
import { IProgramLauncher } from './processLauncher';
import { ILaunchContext } from '../targets';
import * as nls from 'vscode-nls';
import Dap from '../../dap/api';
import { ProtocolError, cannotLaunchInTerminal } from '../../dap/errors';
import { TerminalProcess } from './program';
import { removeNulls } from '../../common/objUtils';
import { ILogger } from '../../common/logging';
import { injectable, inject } from 'inversify';

const localize = nls.loadMessageBundle();

/**
 * Launcher that boots a subprocess.
 */
@injectable()
export class TerminalProgramLauncher implements IProgramLauncher {
  constructor(@inject(ILogger) private readonly logger: ILogger) {}

  public canLaunch(args: INodeLaunchConfiguration) {
    args.internalConsoleOptions;
    return args.console !== 'internalConsole';
  }

  public async launchProgram(
    binary: string,
    config: INodeLaunchConfiguration,
    context: ILaunchContext,
  ) {
    const params: Dap.RunInTerminalParams = {
      kind: config.console === 'integratedTerminal' ? 'integrated' : 'external',
      title: localize('node.console.title', 'Node Debug Console'),
      cwd: config.cwd,
      args: config.program
        ? [binary, ...config.runtimeArgs, config.program, ...config.args]
        : [binary, ...config.runtimeArgs, ...config.args],
      env: removeNulls(config.env),
    };

    let result: Dap.RunInTerminalResult;
    try {
      result = await this.sendLaunchRequest(params, context);
    } catch (err) {
      throw new ProtocolError(cannotLaunchInTerminal(err.message));
    }

    return new TerminalProcess(result, this.logger);
  }

  /**
   * Sends the launch request -- stubbed out in tests.
   */
  public sendLaunchRequest(params: Dap.RunInTerminalParams, context: ILaunchContext) {
    return context.dap.runInTerminalRequest(params);
  }
}
