/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { inject, injectable } from 'inversify';
import { ILogger } from '../../common/logging';
import { removeNulls } from '../../common/objUtils';
import { INodeLaunchConfiguration } from '../../configuration';
import Dap from '../../dap/api';
import { cannotLaunchInTerminal } from '../../dap/errors';
import { ProtocolError } from '../../dap/protocolError';
import { ILaunchContext } from '../targets';
import { getNodeLaunchArgs, IProgramLauncher } from './processLauncher';
import { TerminalProcess } from './program';

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
      title: config.name,
      cwd: config.cwd,
      args: [binary, ...getNodeLaunchArgs(config)],
      env: removeNulls(config.env),
      argsCanBeInterpretedByShell: !Array.isArray(config.args),
    };

    let result: Dap.RunInTerminalResult;
    try {
      result = await this.sendLaunchRequest(params, context);
    } catch (err) {
      throw new ProtocolError(cannotLaunchInTerminal(err.message));
    }

    return new TerminalProcess(result, this.logger, config.killBehavior);
  }

  /**
   * Sends the launch request -- stubbed out in tests.
   */
  public sendLaunchRequest(params: Dap.RunInTerminalParams, context: ILaunchContext) {
    return context.dap.runInTerminalRequest(params);
  }
}
