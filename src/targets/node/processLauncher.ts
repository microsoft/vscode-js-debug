// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as path from 'path';
import * as nls from 'vscode-nls';
import { IProgramLauncher } from './nodeLauncher';
import { EventEmitter } from '../../common/events';
import { INodeLaunchConfiguration } from '../../configuration';
import { ProtocolError } from '../../dap/errors';
import { findInPath, findExecutable } from '../../common/pathUtils';

const localize = nls.loadMessageBundle();

/**
 * Launcher that boots a subprocess.
 */
export abstract class ProcessLauncher implements IProgramLauncher {
  protected _onProgramStoppedEmitter = new EventEmitter<void>();
  public onProgramStopped = this._onProgramStoppedEmitter.event;

  public launchProgram(args: INodeLaunchConfiguration): void {
    const env = {
      ...process.env as ({ [key: string]: string }),
      ...args.env,
    };

    let requestedRuntime = args.runtimeExecutable || 'node';
    const resolvedRuntime = findExecutable(
      path.isAbsolute(requestedRuntime) ? requestedRuntime : findInPath(requestedRuntime, env),
      env,
    );

    if (!resolvedRuntime) {
      throw new ProtocolError({
        id: 2001,
        format: localize(
          'VSND2001',
          "Cannot find runtime '{0}' on PATH. Make sure to have '{0}' installed.",
          requestedRuntime,
        ),
        showUser: true,
        variables: { _runtime: requestedRuntime },
      });
    }

    this.launch({ ...args, env, runtimeExecutable: resolvedRuntime });
  }

  public abstract stopProgram(): void;

  public dispose() {
    this.stopProgram();
  }

  protected abstract launch(args: INodeLaunchConfiguration): void;
}
