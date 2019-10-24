// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as path from 'path';
import * as tmp from 'tmp';
import puppeteer from 'puppeteer';
import * as _ from 'lodash';

import { Dictionary } from 'lodash';
import { logCallsTo, getDebugAdapterLogFilePath, setTestLogName } from './utils/logging';
import { IBeforeAndAfterContext, ITestCallbackContext } from 'mocha';
import { killAllChrome } from './testUtils';
import { DefaultTimeoutMultiplier } from './utils/waitUntilReadyWithTimeout';
import { IChromeLaunchConfiguration, chromeLaunchConfigDefaults } from '../configuration';
import { ExtendedDebugClient } from './testSupport/debugClient';
import * as testSupportSetup from './testSupport/testSetup';
import { startDebugServer } from '../debugServer';
import { IDisposable } from '../common/disposable';
import getPort from 'get-port';

let testLaunchProps: IChromeLaunchConfiguration & Dictionary<unknown> | undefined; // TODO@rob i don't know

export const isThisV2 = true;
export const isThisV1 = !isThisV2;
export const isWindows = process.platform === 'win32';

function formLaunchArgs(
  launchArgs: IChromeLaunchConfiguration & Dictionary<unknown>,
  testTitle: string,
): void {
  launchArgs.type = 'pwa-chrome' as any; // TODO@rob
  launchArgs.logging = { dap: '/tmp/dap.log', cdp: '/tmp/cdp.log' };
  launchArgs.sourceMapPathOverrides = {};
  launchArgs.trace = 'verbose';
  launchArgs.logTimestamps = true;
  launchArgs.disableNetworkCache = true;
  launchArgs.logFilePath = getDebugAdapterLogFilePath(testTitle);

  if (!launchArgs.runtimeExecutable) {
    launchArgs.runtimeExecutable = puppeteer.executablePath();
  }

  const hideWindows = process.env['TEST_DA_HIDE_WINDOWS'] === 'true';
  if (hideWindows) {
    launchArgs.runtimeArgs = ['--headless', '--disable-gpu'];
  }

  // Start with a clean userDataDir for each test run
  const tmpDir = tmp.dirSync({ prefix: 'chrome2-' });
  launchArgs.userDataDir = tmpDir.name;
  if (testLaunchProps) {
    for (let key in testLaunchProps) {
      launchArgs[key] = testLaunchProps[key];
    }
    testLaunchProps = undefined;
  }

  const argsWithDefaults = { ...chromeLaunchConfigDefaults, ...launchArgs };
  for (let k in argsWithDefaults) {
    launchArgs[k] = argsWithDefaults[k];
  }
}

let storedLaunchArgs: Partial<IChromeLaunchConfiguration> = {};

export function launchArgs(): Partial<IChromeLaunchConfiguration> {
  return { ...storedLaunchArgs };
}

function patchLaunchArgs(launchArgs: IChromeLaunchConfiguration, testTitle: string): void {
  formLaunchArgs(launchArgs as any, testTitle); // TODO@rob
  storedLaunchArgs = launchArgs;
}

export const lowercaseDriveLetterDirname = __dirname.charAt(0).toLowerCase() + __dirname.substr(1);
export const PROJECT_ROOT = path.join(lowercaseDriveLetterDirname, '../../../');
export const DATA_ROOT = path.join(PROJECT_ROOT, 'testdata/');

/** Default setup for all our tests, using the context of the setup method
 *    - Best practise: The new best practise is to use the DefaultFixture when possible instead of calling this method directly
 */
export async function setup(
  context: IBeforeAndAfterContext | ITestCallbackContext,
  launchProps?: Partial<IChromeLaunchConfiguration>,
): Promise<ExtendedDebugClient> {
  const currentTest = _.defaultTo(context.currentTest, context.test);
  return setupWithTitle(currentTest.fullTitle(), launchProps);
}

let currentServer: IDisposable | undefined;

/** Default setup for all our tests, using the test title
 *    - Best practise: The new best practise is to use the DefaultFixture when possible instead of calling this method directly
 */
export async function setupWithTitle(
  testTitle: string,
  launchProps?: Partial<IChromeLaunchConfiguration>,
): Promise<ExtendedDebugClient> {
  // killAllChromesOnWin32(); // Kill chrome.exe instances before the tests. Killing them after the tests is not as reliable. If setup fails, teardown is not executed.
  setTestLogName(testTitle);

  if (launchProps) {
    testLaunchProps = launchProps as any; // TODO@rob
  }

  const port = await getPort();
  currentServer = await startDebugServer(port); // TODO@rob
  const debugClient = await testSupportSetup.setup({
    type: 'pwa-chrome',
    patchLaunchArgs: args => patchLaunchArgs(args, testTitle),
    port,
  });
  debugClient.defaultTimeout = DefaultTimeoutMultiplier * 10000 /*10 seconds*/;

  const wrappedDebugClient = logCallsTo(debugClient, 'DebugAdapterClient');
  return wrappedDebugClient;
}

export async function teardown() {
  if (currentServer) {
    currentServer.dispose();
  }

  await testSupportSetup.teardown();
}

export function killAllChromesOnWin32() {
  if (process.platform === 'win32') {
    // We only need to kill the chrome.exe instances on the Windows agent
    // TODO: Figure out a way to remove this
    killAllChrome();
  }
}
