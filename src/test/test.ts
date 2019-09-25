// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as path from 'path';
import * as stream from 'stream';
import { DebugAdapter } from '../adapter/debugAdapter';
import { BrowserLauncher } from '../targets/browser/browserLauncher';
import { BrowserTarget } from '../targets/browser/browserTargets';
import Cdp from '../cdp/api';
import CdpConnection from '../cdp/connection';
import Dap from '../dap/api';
import DapConnection from '../dap/connection';
import * as utils from '../utils/urlUtils';
import { GoldenText } from './goldenText';
import { Logger } from './logger';
import { Binder, BinderDelegate } from '../binder';
import { Target } from '../targets/targets';
import { Disposable, EventEmitter } from '../utils/eventUtils';
import { UiLocation } from '../adapter/sources';
import { BrowserSourcePathResolver } from '../targets/browser/browserPathResolver';
import { SourcePathResolver } from '../common/sourcePathResolver';

export const kStabilizeNames = ['id', 'threadId', 'sourceReference', 'variablesReference'];

class Stream extends stream.Duplex {
  _write(chunk: any, encoding: string, callback: (err?: Error) => void): void {
    this.push(chunk, encoding);
    callback();
  }

  _read(size: number) {
  }
}

export type Log = (value: any, title?: string, stabilizeNames?: string[]) => typeof value;

export class Session implements Disposable {
  readonly debugAdapter: DebugAdapter;
  readonly dap: Dap.TestApi;
  readonly logger: Logger;

  constructor(log: Log, binderDelegate: BinderDelegate | undefined, sourcePathResolver: SourcePathResolver) {
    const testToAdapter = new Stream();
    const adapterToTest = new Stream();
    const adapterConnection = new DapConnection(testToAdapter, adapterToTest);
    const testConnection = new DapConnection(adapterToTest, testToAdapter);
    this.dap = testConnection.createTestApi();

    const workspaceRoot = utils.platformPathToPreferredCase(path.join(__dirname, '..', '..', 'testWorkspace'));

    this.debugAdapter = new DebugAdapter(adapterConnection.dap(), workspaceRoot, sourcePathResolver, {
      copyToClipboard: text => log(`[copy to clipboard] ${text}`),
      revealUiLocation: async (uiLocation: UiLocation) => log(`[reveal]: ${uiLocation.source.url()}:${uiLocation.lineNumber}:${uiLocation.columnNumber}`)
    });
    this.debugAdapter.breakpointManager.setPredictorDisabledForTest(true);
    this.debugAdapter.sourceContainer.setSourceMapTimeouts({
      load: 0,
      resolveLocation: 2000,
      scriptPaused: 1000,
      output: 3000,
    });

    this.logger = new Logger(this.dap, log);
  }

  dispose() {
    this.debugAdapter.dispose();
  }
}

export class TestP {
  readonly adapter: DebugAdapter;
  readonly dap: Dap.TestApi;
  readonly initialize: Promise<Dap.InitializeResult>;
  readonly log: Log;
  readonly assertLog: () => void;
  _cdp: Cdp.Api | undefined;
  _adapter: DebugAdapter | undefined;

  private _goldenText: GoldenText;
  private _root: Session;
  private _sessions = new Map<DebugAdapter, Session>();
  private _connection: CdpConnection | undefined;
  private _evaluateCounter = 0;
  private _workspaceRoot: string;
  private _webRoot: string | undefined;
  private _launchUrl: string | undefined;
  private _args: string[];
  private _blackboxPattern?: string;
  private _worker: Promise<Session>;
  private _workerCallback: (session: Session) => void;
  private _nextLog: Promise<void>;
  private _nextLogCallback: () => void;
  readonly logger: Logger;

  private _browserLauncher: BrowserLauncher;
  readonly binder: Binder;

  private _onSessionCreatedEmitter = new EventEmitter<Session>();
  readonly onSessionCreated = this._onSessionCreatedEmitter.event;

  constructor(goldenText: GoldenText) {
    this._args = ['--headless'];
    this._goldenText = goldenText;
    this.log = this._log.bind(this);
    this._nextLogCallback = () => {};
    this._nextLog = new Promise(f => this._nextLogCallback = f);
    this.assertLog = goldenText.assertLog.bind(goldenText);
    this._workspaceRoot = utils.platformPathToPreferredCase(path.join(__dirname, '..', '..', 'testWorkspace'));
    this._webRoot = path.join(this._workspaceRoot, 'web');

    this._root = new Session(this.log, this, new BrowserSourcePathResolver('http://localhost:8001/', this._webRoot));
    this._sessions.set(this._root.debugAdapter, this._root);
    this.dap = this._root.dap;
    this.adapter = this._root.debugAdapter;
    this.logger = this._root.logger;

    const storagePath = path.join(__dirname, '..', '..');
    this._browserLauncher = new BrowserLauncher(storagePath, this.adapter.sourceContainer.rootPath);
    this.binder = new Binder(this, this.adapter, [this._browserLauncher], '0');
    this.binder.considerLaunchedForTest(this._browserLauncher);

    this.initialize = this.dap.initialize({
      clientID: 'pwa-test',
      adapterID: 'pwa',
      linesStartAt1: true,
      columnsStartAt1: true,
      pathFormat: 'path',
      supportsVariablePaging: true
    });

    this._workerCallback = () => {};
    this._worker = new Promise(f => this._workerCallback = f);
  }

  _log(value: any, title?: string, stabilizeNames?: string[]): typeof value {
    const result = this._goldenText.log(value, title, stabilizeNames);
    this._nextLogCallback();
    this._nextLog = new Promise(f => this._nextLogCallback = f);
    return result;
  }

  nextLog(): Promise<void> {
    return this._nextLog;
  }

  _disposeSessions() {
    for (const session of this._sessions.values())
      session.dispose();
    this._sessions.clear();
  }

  async acquireDebugAdapter(target: Target): Promise<DebugAdapter> {
    if (this._blackboxPattern)
      target.blackboxPattern = () => this._blackboxPattern;

    if (!target.parent())
      return this._root.debugAdapter;

    const session = new Session(this.log, undefined, target.sourcePathResolver());
    this._sessions.set(session.debugAdapter, session);
    session.dap.initialize({
      clientID: 'pwa-test',
      adapterID: 'pwa',
      linesStartAt1: true,
      columnsStartAt1: true,
      pathFormat: 'path',
      supportsVariablePaging: true
    });
    session.dap.configurationDone({});
    this._workerCallback(session);
    this._onSessionCreatedEmitter.fire(session);
    return session.debugAdapter;
  }

  releaseDebugAdapter(target: Target, debugAdapter: DebugAdapter) {
    const session = this._sessions.get(debugAdapter)!;
    session.dispose();
    this._sessions.delete(debugAdapter);
  }

  get cdp(): Cdp.Api {
    return this._cdp!;
  }

  setArgs(args: string[]) {
    this._args = args;
  }

  setBlackboxPattern(blackboxPattern?: string) {
    this._blackboxPattern = blackboxPattern;
  }

  worker(): Promise<Session> {
    return this._worker;
  }

  async _launch(url: string): Promise<BrowserTarget> {
    await this.initialize;
    await this.dap.configurationDone({});
    await this.adapter.breakpointManager.launchBlocker();
    this._launchUrl = url;
    const mainTarget = (await this._browserLauncher.prepareLaunch({url, webRoot: this._webRoot}, this._args, undefined)) as BrowserTarget;
    this._connection = this._browserLauncher.connectionForTest()!;
    const result = await this._connection.rootSession().Target.attachToBrowserTarget({});
    const testSession = this._connection.createSession(result!.sessionId);
    const { sessionId } = (await testSession.Target.attachToTarget({ targetId: mainTarget.id(), flatten: true }))!;
    this._cdp = this._connection.createSession(sessionId);
    return mainTarget;
  }

  async launch(content: string): Promise<void> {
    const url = 'data:text/html;base64,' + new Buffer(content).toString('base64');
    const mainTarget = await this._launch(url);
    await this._browserLauncher.finishLaunch(mainTarget);
  }

  async launchAndLoad(content: string): Promise<void> {
    const url = 'data:text/html;base64,' + new Buffer(content).toString('base64');
    const mainTarget = await this._launch(url);
    await this.cdp.Page.enable({});
    await Promise.all([
      this._browserLauncher.finishLaunch(mainTarget),
      new Promise(f => this.cdp.Page.on('loadEventFired', f))
    ]);
    await this.cdp.Page.disable({});
  }

  async launchUrl(url: string) {
    url = utils.completeUrl('http://localhost:8001/', url) || url;
    const mainTarget = await this._launch(url);
    await this.cdp.Page.enable({});
    await Promise.all([
      this._browserLauncher.finishLaunch(mainTarget),
      new Promise(f => this.cdp.Page.on('loadEventFired', f))
    ]);
    await this.cdp.Page.disable({});
  }

  async disconnect(): Promise<void> {
    return new Promise<void>(cb => {
      this.initialize.then(() => {
        if (this._connection) {
          const disposable = this._connection.onDisconnected(() => {
            this._disposeSessions();
            cb();
            disposable.dispose();
          });
        } else {
          this._disposeSessions();
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
