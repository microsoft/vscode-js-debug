// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as path from 'path';
import * as stream from 'stream';
import { DebugAdapter } from '../adapter/debugAdapter';
import { Target } from '../adapter/targets';
import { BrowserDelegate } from '../browser/browserDelegate';
import { BrowserTarget } from '../browser/browserTargets';
import Cdp from '../cdp/api';
import CdpConnection from '../cdp/connection';
import Dap from '../dap/api';
import DapConnection from '../dap/connection';
import * as utils from '../utils/urlUtils';
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
  _cdp: Cdp.Api | undefined;
  _adapter: DebugAdapter | undefined;

  private _browserDelegate: BrowserDelegate;
  private _connection: CdpConnection | undefined;
  private _evaluateCounter = 0;
  private _workspaceRoot: string;
  private _webRoot: string | undefined;
  private _launchUrl: string | undefined;
  private _args: string[];
  readonly logger: Logger;

  constructor(goldenText: GoldenText) {
    this._args = ['--headless'];
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
    const debugAdapter = new DebugAdapter(adapterConnection.dap());
    this._browserDelegate = new BrowserDelegate(debugAdapter, storagePath, this._workspaceRoot);
    debugAdapter.addDelegate(this._browserDelegate);
    this.dap = testConnection.createTestApi();
    this.initialize = this.dap.initialize({
      clientID: 'pwa-test',
      adapterID: 'pwa',
      linesStartAt1: true,
      columnsStartAt1: true,
      pathFormat: 'path',
      supportsVariablePaging: true
    });
  }

  get adapter(): DebugAdapter {
    return this._adapter!;
  }

  get cdp(): Cdp.Api {
    return this._cdp!;
  }

  setArgs(args: string[]) {
    this._args = args;
  }

  async _launch(url: string): Promise<BrowserTarget> {
    await this.initialize;
    await this.dap.configurationDone({});
    this._launchUrl = url;
    const mainTarget = (await this._browserDelegate.prepareLaunch({url, webRoot: this._webRoot}, this._args)) as BrowserTarget;
    this._adapter = this._browserDelegate.adapter();
    this.adapter.sourceContainer.reportAllLoadedSourcesForTest();

    let contexts: Target[] = [];
    let selected: Target | undefined;
    this.adapter.onTargetForestChanged(() => {
      contexts = [];
      const visit = (item: Target) => {
        contexts.push(item);
        item.children.forEach(visit);
      };
      this.adapter.targetForest().forEach(visit);
    });
    this.adapter.threadManager.onThreadPaused(thread => {
      if (selected && selected.thread === thread) {
        this.adapter.selectTarget(selected);
      } else {
        for (const context of contexts) {
          if (context.thread === thread) {
            this.adapter.selectTarget(context);
            break;
          }
        }
      }
    });
    this.adapter.threadManager.onThreadResumed(thread => {
      this.adapter.selectTarget(selected);
    });

    this._connection = this._browserDelegate.connectionForTest()!;
    const result = await this._connection.rootSession().Target.attachToBrowserTarget({});
    const testSession = this._connection.createSession(result!.sessionId);
    const { sessionId } = (await testSession.Target.attachToTarget({ targetId: mainTarget.targetId, flatten: true }))!;
    this._cdp = this._connection.createSession(sessionId);
    return mainTarget;
  }

  async launch(content: string): Promise<void> {
    const url = 'data:text/html;base64,' + new Buffer(content).toString('base64');
    const mainTarget = await this._launch(url);
    await this._browserDelegate.finishLaunch(mainTarget);
  }

  async launchAndLoad(content: string): Promise<void> {
    const url = 'data:text/html;base64,' + new Buffer(content).toString('base64');
    const mainTarget = await this._launch(url);
    await this.cdp.Page.enable({});
    await Promise.all([
      this._browserDelegate.finishLaunch(mainTarget),
      new Promise(f => this.cdp.Page.on('loadEventFired', f))
    ]);
    await this.cdp.Page.disable({});
  }

  async launchUrl(url: string) {
    url = utils.completeUrl('http://localhost:8001/', url) || url;
    const mainTarget = await this._launch(url);
    await this.cdp.Page.enable({});
    await Promise.all([
      this._browserDelegate.finishLaunch(mainTarget),
      new Promise(f => this.cdp.Page.on('loadEventFired', f))
    ]);
    await this.cdp.Page.disable({});
  }

  async disconnect(): Promise<void> {
    return new Promise<void>(cb => {
      this.initialize.then(() => {
        if (this._connection) {
          const disposable = this._connection.onDisconnected(() => {
            cb();
            disposable.dispose();
          });
        } else {
          cb();
        }
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

  completeUrl(relativePath: string): string {
    return utils.completeUrl(this._launchUrl, relativePath) || '';
  }

  async addScriptTag(relativePath: string): Promise<void> {
    await this.cdp.Runtime.evaluate({expression: `
      new Promise(f => {
        var script = document.createElement('script');
        script.src = '${this.completeUrl(relativePath)}';
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
