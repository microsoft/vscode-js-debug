// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as path from 'path';
import * as stream from 'stream';
import * as utils from '../utils/urlUtils';
import { Adapter } from '../adapter/adapter';
import Cdp from '../cdp/api';
import CdpConnection from '../cdp/connection';
import { ChromeAdapter } from '../chrome/chromeAdapter';
import Dap from '../dap/api';
import DapConnection from '../dap/connection';
import { Target } from '../chrome/targets';
import { GoldenText } from './goldenText';
import { Logger } from './logger';

export const kStabilizeNames = ['id', 'threadId', 'sourceReference', 'variablesReference'];

class Stream extends stream.Duplex {
  _write(chunk: any, encoding: string, callback: (err?: Error) => void): void {
    this.push(chunk, encoding);
    callback();
  }

  _read(size: number) {
  }
}

export class TestP {
  readonly dap: Dap.TestApi;
  readonly initialize: Promise<Dap.InitializeResult>;
  readonly log: (value: any, title?: string, stabilizeNames?: string[]) => typeof value;
  readonly assertLog: () => void;
  cdp: Cdp.Api;
  adapter: Adapter;

  private _chromeAdapter: ChromeAdapter;
  private _connection: CdpConnection;
  private _evaluateCounter = 0;
  private _workspaceRoot: string;
  private _webRoot: string;
  private _launchUrl: string;
  readonly logger: Logger;

  constructor(goldenText: GoldenText) {
    this.log = goldenText.log.bind(goldenText);
    this.logger = new Logger(this);
    this.assertLog = goldenText.assertLog.bind(goldenText);
    const testToAdapter = new Stream();
    const adapterToTest = new Stream();
    const adapterConnection = new DapConnection(testToAdapter, adapterToTest);
    const testConnection = new DapConnection(adapterToTest, testToAdapter);
    const storagePath = path.join(__dirname, '..', '..');
    this._workspaceRoot = path.join(__dirname, '..', '..', 'testWorkspace');
    this._webRoot = path.join(this._workspaceRoot, 'web');
    this._chromeAdapter = new ChromeAdapter(adapterConnection.dap(), storagePath, this._workspaceRoot, () => { });
    this.dap = testConnection.createTestApi();
    this.initialize = this._chromeAdapter.initialize({
      clientID: 'pwa-test',
      adapterID: 'pwa',
      linesStartAt1: true,
      columnsStartAt1: true,
      pathFormat: 'path',
      supportsVariablePaging: true
    }, true /* isUnderTest */).then(async result => {
      this._connection = await this._chromeAdapter.connection().clone();
      return result as Dap.InitializeResult;
    });
  }

  async _launch(url: string): Promise<Target> {
    await this.initialize;
    await this.dap.configurationDone({});
    this._launchUrl = url;
    const mainTarget = (await this._chromeAdapter.prepareLaunch({url, webRoot: this._webRoot}))!;
    this.adapter = this._chromeAdapter.adapter();
    const { sessionId } = (await this._connection.browser().Target.attachToTarget({ targetId: mainTarget.targetId(), flatten: true }))!;
    this.cdp = this._connection.createSession(sessionId);
    return mainTarget;
  }

  async launch(content: string): Promise<void> {
    const url = 'data:text/html;base64,' + new Buffer(content).toString('base64');
    const mainTarget = await this._launch(url);
    await this._chromeAdapter.finishLaunch(mainTarget);
  }

  async launchAndLoad(content: string): Promise<void> {
    const url = 'data:text/html;base64,' + new Buffer(content).toString('base64');
    const mainTarget = await this._launch(url);
    await this.cdp.Page.enable({});
    await Promise.all([
      this._chromeAdapter.finishLaunch(mainTarget),
      new Promise(f => this.cdp.Page.on('loadEventFired', f))
    ]);
    await this.cdp.Page.disable({});
  }

  async launchUrl(url: string) {
    url = utils.completeUrl('http://localhost:8001/', url) || url;
    const mainTarget = await this._launch(url);
    await this.cdp.Page.enable({});
    await Promise.all([
      this._chromeAdapter.finishLaunch(mainTarget),
      new Promise(f => this.cdp.Page.on('loadEventFired', f))
    ]);
    await this.cdp.Page.disable({});
  }

  disconnect(): Promise<void> {
    return new Promise(cb => {
      this.initialize.then(() => {
        const disposable = this._connection.onDisconnected(() => {
          cb();
          disposable.dispose();
        });
        this.dap.disconnect({});
      });
    });
  }

  async evaluate(expression: string, sourceUrl?: string): Promise<Cdp.Runtime.EvaluateResult> {
    ++this._evaluateCounter;
    this.log(`Evaluating#${this._evaluateCounter}: ${expression}`);
    if (sourceUrl === undefined)
      sourceUrl = `//# sourceURL=eval${this._evaluateCounter}.js`;
    else if (sourceUrl)
      sourceUrl = `//# sourceURL=${utils.completeUrl(this._launchUrl, sourceUrl)}`;
    return this.cdp.Runtime.evaluate({ expression: expression + `\n${sourceUrl}` }).then(result => {
      if (!result) {
        this.log(expression, 'Error evaluating');
        debugger;
        throw new Error('Error evaluating "' + expression + '"');
      } else if (result.exceptionDetails) {
        this.log(result.exceptionDetails, 'Error evaluating');
        debugger;
        throw new Error('Error evaluating "' + expression + '"');
      }
      return result;
    });
  }

  async addScriptTag(relativePath: string): Promise<void> {
    await this.cdp.Runtime.evaluate({expression: `
      new Promise(f => {
        var script = document.createElement('script');
        script.src = '${utils.completeUrl(this._launchUrl, relativePath)}';
        script.onload = () => f(undefined);
        document.head.appendChild(script);
      })
    `, awaitPromise: true});
  }

  waitForSource(filter?: string): Promise<Dap.LoadedSourceEventParams> {
    return this.dap.once('loadedSource', event => {
      return filter === undefined || (event.source.path || '').indexOf(filter) !== -1;
    });
  }

  workspacePath(relative: string): string {
    return path.join(this._workspaceRoot, relative);
  }
}
