// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { INodeLaunchConfiguration } from '../../configuration';
import { ProcessLauncher } from './processLauncher';
import { ILaunchContext } from '../targets';
import * as nls from 'vscode-nls';
import Dap from '../../dap/api';
import { ProtocolError, cannotLaunchInTerminal } from '../../dap/errors';
import { TerminalProcess } from './program';
import { removeNulls } from '../../common/objUtils';

const localize = nls.loadMessageBundle();

/**
 * Launcher that boots a subprocess.
 */
export class TerminalProgramLauncher extends ProcessLauncher {
  public canLaunch(args: INodeLaunchConfiguration) {
    args.internalConsoleOptions;
    return args.console !== 'internalConsole';
  }

  public async launchProgram(config: INodeLaunchConfiguration, context: ILaunchContext) {
    const params: Dap.RunInTerminalParams = {
      kind: config.console === 'integratedTerminal' ? 'integrated' : 'external',
      title: localize('node.console.title', 'Node Debug Console'),
      cwd: config.cwd,
      args: [
        this.getRuntime(config),
        ...config.runtimeArgs,
        config.program,
        ...config.args,
      ],
      env: removeNulls(config.env),
    };

    let result: Dap.RunInTerminalResult;
    try {
      result = await this.sendLaunchRequest(params, context);
    } catch (err) {
      throw new ProtocolError(cannotLaunchInTerminal(err.message));
    }

    return new TerminalProcess(result);
  }

  /**
   * Sends the launch request -- stubbed out in tests.
   */
  public sendLaunchRequest(params: Dap.RunInTerminalParams, context: ILaunchContext) {
    return context.dap.runInTerminalRequest(params);
  }
}
