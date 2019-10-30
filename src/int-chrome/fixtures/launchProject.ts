// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { IFixture } from './fixture';
import { DefaultFixture } from './defaultFixture';
import { LaunchWebServer, ProvideStaticUrl } from './launchWebServer';
import { Page, Browser } from 'puppeteer';
import { ITestCallbackContext, IBeforeAndAfterContext } from 'mocha';
import { URL } from 'url';
import { IChromeLaunchConfiguration, IChromeAttachConfiguration } from '../../configuration';
import { ExtendedDebugClient } from '../testSupport/debugClient';
import { PausedWizard } from '../wizards/pausedWizard';
import { BreakpointsWizard } from '../wizards/breakpoints/breakpointsWizard';
import { LaunchPuppeteer } from '../puppeteer/launchPuppeteer';
import { TestProjectSpec } from '../framework/frameworkTestSupport';
import { IDebugAdapterCallbacks, IScenarioConfiguration } from '../intTestSupport';

/** Perform all the steps neccesary to launch a particular project such as:
 *    - Default fixture/setup
 *    - Launch web-server
 *    - Connect puppeteer to Chrome
 */
export class LaunchProject implements IFixture {
  private constructor(
    private readonly _defaultFixture: DefaultFixture,
    private readonly _launchWebServer: LaunchWebServer | ProvideStaticUrl,
    public readonly pausedWizard: PausedWizard,
    public readonly breakpoints: BreakpointsWizard,
    private readonly _launchPuppeteer: LaunchPuppeteer,
  ) {}

  public static async launch(
    testContext: IBeforeAndAfterContext | ITestCallbackContext,
    testSpec: TestProjectSpec,
    launchConfig: IChromeLaunchConfiguration = {} as IChromeLaunchConfiguration,
    callbacks: IDebugAdapterCallbacks = {},
  ): Promise<LaunchProject> {
    return this.start(testContext, testSpec, { ...launchConfig, scenario: 'launch' }, callbacks);
  }

  public static async attach(
    testContext: IBeforeAndAfterContext | ITestCallbackContext,
    testSpec: TestProjectSpec,
    attachConfig: IChromeAttachConfiguration = { port: 0 } as IChromeAttachConfiguration,
    callbacks: IDebugAdapterCallbacks = {},
  ): Promise<LaunchProject> {
    return this.start(testContext, testSpec, { ...attachConfig, scenario: 'attach' }, callbacks);
  }

  public static async start(
    testContext: IBeforeAndAfterContext | ITestCallbackContext,
    testSpec: TestProjectSpec,
    daConfig: IScenarioConfiguration,
    callbacks: IDebugAdapterCallbacks,
  ): Promise<LaunchProject> {
    const launchWebServer = testSpec.staticUrl
      ? new ProvideStaticUrl(new URL(testSpec.staticUrl), testSpec)
      : await LaunchWebServer.launch(testSpec);

    const defaultFixture = await DefaultFixture.create(testContext);

    // We need to create the PausedWizard before launching the debuggee to listen to all events and avoid race conditions
    const pausedWizard = PausedWizard.forClient(defaultFixture.debugClient);
    const breakpointsWizard = BreakpointsWizard.createWithPausedWizard(
      defaultFixture.debugClient,
      pausedWizard,
      testSpec,
    );

    const chromeArgsForPuppeteer =
      daConfig.scenario === 'attach' ? [launchWebServer.url.toString()] : []; // For attach we need to launch puppeteer/chrome pointing to the web-server
    const launchConfig = { ...launchWebServer.launchConfig };

    const launchPuppeteer = await LaunchPuppeteer.start(
      defaultFixture.debugClient,
      { ...launchConfig, ...daConfig },
      chromeArgsForPuppeteer,
      callbacks,
    );
    return new LaunchProject(
      defaultFixture,
      launchWebServer,
      pausedWizard,
      breakpointsWizard,
      launchPuppeteer,
    );
  }

  /** Client for the debug adapter being used for this test */
  public get debugClient(): ExtendedDebugClient {
    return this._defaultFixture.debugClient;
  }

  /** Object to control the debugged browser via puppeteer */
  public get browser(): Browser {
    return this._launchPuppeteer.browser;
  }

  /** Object to control the debugged page via puppeteer */
  public get page(): Page {
    return this._launchPuppeteer.page;
  }

  public get url(): URL {
    return this._launchWebServer.url;
  }

  public async cleanUp(): Promise<void> {
    await this.pausedWizard.waitAndAssertNoMoreEvents();
    await this._defaultFixture.cleanUp(); // Disconnect the debug-adapter first
    await this._launchPuppeteer.cleanUp(); // Then disconnect puppeteer and close chrome
    await this._launchWebServer.cleanUp(); // Finally disconnect the web-server
  }
}
