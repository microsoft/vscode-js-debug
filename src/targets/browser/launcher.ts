/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as childProcess from 'child_process';
import CdpConnection from '../../cdp/connection';
import { WebSocketTransport } from '../../cdp/webSocketTransport';
import { EnvironmentVars } from '../../common/environmentVars';
import { ITelemetryReporter } from '../../telemetry/telemetryReporter';
import { CancellationToken } from 'vscode';
import { launchUnelevatedChrome } from './unelevatedChome';
import {
  IBrowserProcess,
  NonTrackedBrowserProcess,
  ChildProcessBrowserProcess,
} from './spawn/browserProcess';
import Dap from '../../dap/api';
import { ILogger } from '../../common/logging';
import { IDapInitializeParamsWithExtensions } from './browserLauncher';
import { retryGetWSEndpoint } from './spawn/endpoints';
import { BrowserArgs } from './browserArgs';
import { constructInspectorWSUri } from './constructInspectorWSUri';

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
  url?: string | null;
  promisedPort?: Promise<number>;
  inspectUri?: string | null;
  cleanUp?: 'wholeBrowser' | 'onlyTab';
}

export interface ILaunchResult {
  cdp: CdpConnection;
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
    url,
    inspectUri,
  } = options;

  let browserArguments = new BrowserArgs(args);
  let actualConnection = browserArguments.getSuggestedConnection();
  if (actualConnection === undefined) {
    browserArguments = browserArguments.setConnection(defaultConnection);
    actualConnection = defaultConnection;
  }

  browserArguments = defaultArgs(browserArguments, options);

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
    browserProcess = new NonTrackedBrowserProcess();
  } else {
    const cp = childProcess.spawn(executablePath, browserArguments.toArray(), {
      // On non-windows platforms, `detached: false` makes child process a leader of a new
      // process group, making it possible to kill child process tree with `.kill(-pid)` command.
      // @see https://nodejs.org/api/child_process.html#child_process_options_detached
      detached: process.platform !== 'win32',
      env: env.defined(),
      cwd,
      stdio,
    }) as childProcess.ChildProcessWithoutNullStreams;

    if (cp.pid === undefined) {
      throw new Error('Unable to launch the executable');
    }

    browserProcess = new ChildProcessBrowserProcess(cp, logger);
  }

  if (dumpio) {
    browserProcess.stderr?.on('data', d => onStderr(d.toString()));
    browserProcess.stdout?.on('data', d => onStdout(d.toString()));
  }

  let exitListener = () => {
    if (options.cleanUp === 'wholeBrowser') {
      browserProcess.kill();
    }
  };
  process.on('exit', exitListener);
  browserProcess.onExit(() => process.removeListener('exit', exitListener));

  try {
    if (options.promisedPort) {
      actualConnection = await options.promisedPort;
    }

    const transport = await browserProcess.transport(
      {
        connection: actualConnection,
        inspectUri: inspectUri || undefined,
        url: url || undefined,
      },
      cancellationToken,
    );

    const cdp = new CdpConnection(transport, logger, telemetryReporter);
    exitListener = async () => {
      if (options.cleanUp === 'wholeBrowser') {
        await cdp.rootSession().Browser.close({});
        browserProcess.kill();
      } else {
        cdp.close();
      }
    };
    return { cdp: cdp, process: browserProcess };
  } catch (e) {
    exitListener();
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
    const connectionURL = await retryGetWSEndpoint(browserURL, cancellationToken);

    const inspectWs = options.inspectUri
      ? constructInspectorWSUri(options.inspectUri, options.pageURL, connectionURL)
      : connectionURL;

    const connectionTransport = await WebSocketTransport.create(inspectWs, cancellationToken);
    return new CdpConnection(connectionTransport, logger, telemetryReporter);
  }
  throw new Error('Either browserURL or browserWSEndpoint needs to be specified');
}
