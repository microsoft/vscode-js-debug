// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as path from 'path';
import * as nls from 'vscode-nls';
import * as fs from 'fs';
import { IProgramLauncher } from './nodeLauncher';
import { EventEmitter } from '../../common/events';
import { INodeLaunchConfiguration } from '../../configuration';
import { ProtocolError, createUserError } from '../../dap/errors';
import { findInPath, findExecutable } from '../../common/pathUtils';
import { EnvironmentVars } from '../../common/environmentVars';
import { ILaunchContext } from '../targets';

const localize = nls.loadMessageBundle();

/**
 * Launcher that boots a subprocess.
 */
export abstract class ProcessLauncher implements IProgramLauncher {
  protected _onProgramStoppedEmitter = new EventEmitter<void>();
  public onProgramStopped = this._onProgramStoppedEmitter.event;

  public async launchProgram(args: INodeLaunchConfiguration, context: ILaunchContext): Promise<void> {
    const env = this.resolveEnvironment(args);
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

    await this.launch({ ...args, env, runtimeExecutable: resolvedRuntime }, context);
  }

  private resolveEnvironment(args: INodeLaunchConfiguration) {
    let env = new EnvironmentVars(process.env);

    // read environment variables from any specified file
    if (args.envFile) {
      try {
        env = env.merge(readEnvFile(args.envFile));
      } catch (e) {
        throw new ProtocolError(
          createUserError(
            localize('VSND2029', "Can't load environment variables from file ({0}).", e.message),
          ),
        );
      }
    }

    return env.merge(args.env).value;
  }

  public abstract stopProgram(): void;

  public dispose() {
    this.stopProgram();
  }

  protected abstract launch(args: INodeLaunchConfiguration, context: ILaunchContext): Promise<number>;
}

function readEnvFile(file: string): { [key: string]: string } {
  if (!fs.existsSync(file)) {
    return {};
  }

  const buffer = stripBOM(fs.readFileSync(file, 'utf8'));
  const env = {};
  for (const line of buffer.split('\n')) {
    const r = line.match(/^\s*([\w\.\-]+)\s*=\s*(.*)?\s*$/);
    if (!r) {
      continue;
    }

    let [, key, value = ''] = r;
    // .env variables never overwrite existing variables (see #21169)
    if (value.length > 0 && value.charAt(0) === '"' && value.charAt(value.length - 1) === '"') {
      value = value.replace(/\\n/gm, '\n');
    }
    env[key] = value.replace(/(^['"]|['"]$)/g, '');
  }

  return env;
}

function stripBOM(s: string): string {
  if (s && s[0] === '\uFEFF') {
    s = s.substr(1);
  }
  return s;
}
