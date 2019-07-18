/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as path from 'path';
import * as stream from 'stream';
import { Adapter } from '../adapter/adapter';
import Cdp from '../cdp/api';
import CdpConnection from '../cdp/connection';
import { ChromeAdapter } from '../chrome/chromeAdapter';
import Dap from '../dap/api';
import DapConnection from '../dap/connection';
import { Target } from '../chrome/targets';
import { GoldenText } from './goldenText';

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

  constructor(goldenText: GoldenText) {
    this.log = goldenText.log.bind(goldenText);
    this.assertLog = goldenText.assertLog.bind(goldenText);
    const testToAdapter = new Stream();
    const adapterToTest = new Stream();
    const adapterConnection = new DapConnection(testToAdapter, adapterToTest);
    const testConnection = new DapConnection(adapterToTest, testToAdapter);
    this._chromeAdapter = new ChromeAdapter(adapterConnection.dap(), path.join(__dirname, '../..'), '', () => { });
    this.dap = testConnection.createTestApi();
    this.initialize = this._chromeAdapter.initialize({
      clientID: 'cdp-test',
      adapterID: 'cdp',
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
    const mainTarget = (await this._chromeAdapter.prepareLaunch({url}))!;
    this.adapter = this._chromeAdapter.adapter();
    const { sessionId } = (await this._connection.browser().Target.attachToTarget({ targetId: mainTarget.targetId(), flatten: true }))!;
    this.cdp = this._connection.createSession(sessionId);
    return mainTarget;
  }

  async launch(url: string): Promise<void> {
    const mainTarget = await this._launch(url);
    await this._chromeAdapter.finishLaunch(mainTarget);
  }

  async launchAndLoad(url: string): Promise<void> {
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

  async evaluate(expression: string): Promise<Cdp.Runtime.EvaluateResult> {
    ++this._evaluateCounter;
    this.log(`Evaluating#${this._evaluateCounter}: ${expression}`);
    return this.cdp.Runtime.evaluate({ expression: expression + `\n//# sourceURL=eval${this._evaluateCounter}.js` }).then(result => {
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
}
