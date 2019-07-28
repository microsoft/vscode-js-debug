/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as path from 'path';
import * as stream from 'stream';
import * as utils from '../utils/urlUtils';
import Cdp from '../cdp/api';
import CdpConnection from '../cdp/connection';
import { ChromeAdapter } from '../chrome/chromeAdapter';
import Dap from '../dap/api';
import DapConnection from '../dap/connection';
import { Target } from '../chrome/targets';
import { GoldenText } from './goldenText';
import { Logger } from './logger';
import { ExecutionContext } from '../adapter/threads';
import { DebugAdapter } from '../adapter/debugAdapter';

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
  adapter: DebugAdapter;

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
    const debugAdapter = new DebugAdapter(adapterConnection.dap());
    this._chromeAdapter = new ChromeAdapter(debugAdapter, storagePath, this._workspaceRoot);
    debugAdapter.addDelegate(this._chromeAdapter);
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

  async _launch(url: string): Promise<Target> {
    await this.initialize;
    await this.dap.configurationDone({});
    this._launchUrl = url;
    const mainTarget = (await this._chromeAdapter.prepareLaunch({url, webRoot: this._webRoot}, true)) as Target;
    this._connection = await this._chromeAdapter.connection().clone();
    this.adapter = this._chromeAdapter.adapter();

    let contexts: ExecutionContext[] = [];
    let selected: ExecutionContext | undefined;
    this.adapter.onExecutionContextForestChanged(params => {
      contexts = [];
      const visit = (item: ExecutionContext) => {
        contexts.push(item);
        item.children.forEach(visit);
      };
      params.forEach(visit);
    });
    this.adapter.threadManager.onThreadPaused(thread => {
      if (selected && selected.thread === thread) {
        this.adapter.selectExecutionContext(selected);
      } else {
        for (const context of contexts) {
          if (context.thread === thread) {
            this.adapter.selectExecutionContext(context);
            break;
          }
        }
      }
    });
    this.adapter.threadManager.onThreadResumed(thread => {
      this.adapter.selectExecutionContext(selected);
    });

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
