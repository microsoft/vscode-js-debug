/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as childProcess from 'child_process';
import { promises as fsPromises } from 'fs';
import { CancellationToken } from 'vscode';
import CdpConnection from '../../cdp/connection';
import { WebSocketTransport } from '../../cdp/webSocketTransport';
import { IDisposable } from '../../common/disposable';
import { EnvironmentVars } from '../../common/environmentVars';
import { canAccess } from '../../common/fsUtils';
import { ILogger, LogTag } from '../../common/logging';
import { formatSubprocessArguments } from '../../common/processUtils';
import { delay } from '../../common/promiseUtil';
import Dap from '../../dap/api';
import { browserProcessExitedBeforePort } from '../../dap/errors';
import { ProtocolError } from '../../dap/protocolError';
import { ITelemetryReporter } from '../../telemetry/telemetryReporter';
import { BrowserArgs } from './browserArgs';
import { IDapInitializeParamsWithExtensions } from './browserLauncher';
import { constructInspectorWSUri } from './constructInspectorWSUri';
import {
  ChildProcessBrowserProcess,
  IBrowserProcess,
  NonTrackedBrowserProcess,
} from './spawn/browserProcess';
import { retryGetBrowserEndpoint } from './spawn/endpoints';
import { launchUnelevatedChrome } from './unelevatedChome';

const noop = () => undefined;

interface ILaunchOptions {
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
  args?: ReadonlyArray<string>;
  dumpio?: boolean;
  hasUserNavigation?: boolean;
  cwd?: string;
  env?: EnvironmentVars;
  ignoreDefaultArgs?: boolean | string[];
  connection?: 'pipe' | number; // pipe or port number
  userDataDir?: string;
  launchUnelevated?: boolean;
  includeLaunchArgs?: boolean;
  url?: string | null;
  promisedPort?: Promise<number>;
  inspectUri?: string | null;
  cleanUp?: 'wholeBrowser' | 'onlyTab';
}

export interface ILaunchResult {
  canReconnect: boolean;
  createConnection(cancellationToken: CancellationToken): Promise<CdpConnection>;
  process: IBrowserProcess;
}

export async function launch(
  dap: Dap.Api,
  executablePath: string,
  logger: ILogger,
  telemetryReporter: ITelemetryReporter,
  clientCapabilities: IDapInitializeParamsWithExtensions,
  cancellationToken: CancellationToken,
  options: ILaunchOptions | undefined = {},
): Promise<ILaunchResult> {
  const {
    onStderr = noop,
    onStdout = noop,
    args = [],
    dumpio = false,
    cwd = process.cwd(),
    env = EnvironmentVars.empty,
    connection: defaultConnection = 'pipe',
    cleanUp = 'wholeBrowser',
    url,
    inspectUri,
  } = options;

  let browserArguments = new BrowserArgs(args);
  let actualConnection = browserArguments.getSuggestedConnection();

  if (options.includeLaunchArgs !== false) {
    browserArguments = defaultArgs(browserArguments, options);
    if (actualConnection === undefined) {
      browserArguments = browserArguments.setConnection(defaultConnection);
      actualConnection = defaultConnection;
    }
  } else if (actualConnection === undefined) {
    actualConnection = 'pipe';
  }

  let stdio: ('pipe' | 'ignore')[] = ['pipe', 'pipe', 'pipe'];
  if (actualConnection === 'pipe') {
    if (dumpio) stdio = ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'];
    else stdio = ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'];
  }

  let browserProcess: IBrowserProcess;
  const launchUnelevated = !!(
    clientCapabilities.supportsLaunchUnelevatedProcessRequest && options.launchUnelevated
  );
  if (launchUnelevated && typeof actualConnection === 'number' && actualConnection !== 0) {
    await launchUnelevatedChrome(
      dap,
      executablePath,
      browserArguments.toArray(),
      cancellationToken,
    );
    browserProcess = new NonTrackedBrowserProcess(logger);
  } else {
    logger.info(LogTag.RuntimeLaunch, `Launching Chrome from ${executablePath}`);

    const formatted = formatSubprocessArguments(
      executablePath,
      browserArguments.toArray(),
      (await canAccess(fsPromises, cwd)) ? cwd : process.cwd(),
    );

    const cp = childProcess.spawn(formatted.executable, formatted.args, {
      detached: true,
      env: env.defined(),
      shell: formatted.shell,
      cwd: formatted.cwd,
      stdio,
    }) as childProcess.ChildProcessWithoutNullStreams;

    // If the PID is undefined, the launch failed; expect to see an error be
    // emitted presently, or just throw a generic error if not.
    if (cp.pid === undefined) {
      throw await Promise.race([
        delay(1000).then(() => new Error('Unable to launch the executable (undefined pid)')),
        new Promise(r => cp.once('error', r)),
      ]);
    }

    browserProcess = new ChildProcessBrowserProcess(cp, logger);
  }

  if (dumpio) {
    browserProcess.stderr?.on('data', d => onStderr(d.toString()));
    browserProcess.stdout?.on('data', d => onStdout(d.toString()));
  } else {
    browserProcess.stderr?.resume();
    browserProcess.stdout?.resume();
  }

  const exitListener = () => {
    if (cleanUp === 'wholeBrowser') {
      browserProcess.kill();
    }
  };
  process.on('exit', exitListener);
  browserProcess.onExit(() => process.removeListener('exit', exitListener));

  try {
    if (options.promisedPort) {
      let listener: IDisposable;

      actualConnection = await Promise.race([
        options.promisedPort,
        new Promise<never>((_resolve, reject) => {
          listener = browserProcess.onExit(code => {
            reject(new ProtocolError(browserProcessExitedBeforePort(code)));
          });
        }),
      ]).finally(() => listener.dispose());
    }

    return {
      process: browserProcess,
      // can only reconnect to debug ports, not pipe connections:
      canReconnect: typeof actualConnection === 'number',
      createConnection: async cancellationToken => {
        const transport = await browserProcess.transport(
          {
            connection: actualConnection!,
            inspectUri: inspectUri || undefined,
            url: url || undefined,
          },
          cancellationToken,
        );

        return new CdpConnection(transport, logger, telemetryReporter);
      },
    };
  } catch (e) {
    browserProcess.kill();
    throw e;
  }
}

export function defaultArgs(
  defined: BrowserArgs,
  options: Pick<ILaunchOptions, 'userDataDir' | 'ignoreDefaultArgs' | 'hasUserNavigation'> = {},
): BrowserArgs {
  const { userDataDir = null, ignoreDefaultArgs = false } = options;
  let browserArguments = ignoreDefaultArgs === true ? new BrowserArgs() : BrowserArgs.default;
  if (ignoreDefaultArgs instanceof Array) {
    browserArguments = browserArguments.filter(key => !ignoreDefaultArgs.includes(key));
  }

  if (userDataDir) {
    browserArguments = browserArguments.add('--user-data-dir', userDataDir);
  }

  browserArguments = browserArguments.merge(defined);

  if (defined.toArray().every(arg => arg.startsWith('-')) && options.hasUserNavigation) {
    browserArguments = browserArguments.add('about:blank');
  }

  return browserArguments;
}

interface IAttachOptions {
  browserURL?: string;
  browserWSEndpoint?: string;
  pageURL?: string | null;
  inspectUri?: string | null;
}

export async function attach(
  options: IAttachOptions,
  cancellationToken: CancellationToken,
  logger: ILogger,
  telemetryReporter: ITelemetryReporter,
): Promise<CdpConnection> {
  const { browserWSEndpoint, browserURL } = options;

  if (browserWSEndpoint) {
    const connectionTransport = await WebSocketTransport.create(
      browserWSEndpoint,
      cancellationToken,
    );
    return new CdpConnection(connectionTransport, logger, telemetryReporter);
  } else if (browserURL) {
    const connectionURL = await retryGetBrowserEndpoint(browserURL, cancellationToken, logger);

    const inspectWs = options.inspectUri
      ? constructInspectorWSUri(options.inspectUri, options.pageURL, connectionURL)
      : connectionURL;

    const connectionTransport = await WebSocketTransport.create(inspectWs, cancellationToken);
    return new CdpConnection(connectionTransport, logger, telemetryReporter);
  }
  throw new Error('Either browserURL or browserWSEndpoint needs to be specified');
}
