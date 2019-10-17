// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as path from 'path';
import * as fs from 'fs';
import * as stream from 'stream';
import * as mkdirp from 'mkdirp';
import { DebugAdapter } from '../adapter/debugAdapter';
import { BrowserLauncher } from '../targets/browser/browserLauncher';
import Cdp from '../cdp/api';
import CdpConnection from '../cdp/connection';
import Dap from '../dap/api';
import DapConnection from '../dap/connection';
import * as utils from '../common/urlUtils';
import { GoldenText } from './goldenText';
import { Logger } from './logger';
import { Binder } from '../binder';
import { Target } from '../targets/targets';
import { EventEmitter } from '../common/events';
import { IChromeLaunchConfiguration, chromeLaunchConfigDefaults } from '../configuration';
import { tmpdir } from 'os';

export const kStabilizeNames = ['id', 'threadId', 'sourceReference', 'variablesReference'];

export const testWorkspace = path.join(__dirname, '..', '..', '..', 'testWorkspace');
export const testSources = path.join(__dirname, '..', '..', '..', 'src');
export const testFixturesDir = path.join(tmpdir(), 'vscode-pwa-test');

class Stream extends stream.Duplex {
  _write(chunk: any, encoding: string, callback: (err?: Error) => void): void {
    Promise.resolve().then().then().then().then().then().then().then().then().then().then().then(() => {
      this.push(chunk, encoding);
      callback();
    });
  }

  _read(size: number) {
  }
}

export type Log = (value: any, title?: string, stabilizeNames?: string[]) => typeof value;

class Session {
  readonly dap: Dap.TestApi;
  readonly adapterConnection: DapConnection;

  constructor() {
    const testToAdapter = new Stream();
    const adapterToTest = new Stream();
    this.adapterConnection = new DapConnection();
    this.adapterConnection.init(testToAdapter, adapterToTest);
    const testConnection = new DapConnection();
    testConnection.init(adapterToTest, testToAdapter);
    this.dap = testConnection.createTestApi();
  }

  async _init(): Promise<Dap.InitializeResult> {
    await this.adapterConnection.dap();
    const [r, ] = await Promise.all([
      this.dap.initialize({
        clientID: 'pwa-test',
        adapterID: 'pwa',
        linesStartAt1: true,
        columnsStartAt1: true,
        pathFormat: 'path',
        supportsVariablePaging: true
      }),
      this.dap.once('initialized')
    ]);
    return r;
  }
}

export class TestP {
  readonly dap: Dap.TestApi;
  readonly logger: Logger;
  readonly log: Log;
  readonly assertLog: () => void;

  _session: Session;
  _adapter?: DebugAdapter;
  private _root: TestRoot;
  private _evaluateCounter = 0;
  private _connection: CdpConnection | undefined;
  private _cdp: Cdp.Api | undefined;
  private _target: Target;

  constructor(root: TestRoot, target: Target) {
    this._root = root;
    this._target = target;
    this.log = root.log;
    this.assertLog = root.assertLog;
    this._session = new Session();
    this.dap = this._session.dap;
    this.logger = new Logger(this.dap, this.log);
  }

  get cdp(): Cdp.Api {
    return this._cdp!;
  }

  get adapter(): DebugAdapter {
    return this._adapter!;
  }

  async evaluate(expression: string, sourceUrl?: string): Promise<Cdp.Runtime.EvaluateResult> {
    ++this._evaluateCounter;
    this.log(`Evaluating#${this._evaluateCounter}: ${expression}`);
    if (sourceUrl === undefined)
      sourceUrl = `//# sourceURL=eval${this._evaluateCounter}.js`;
    else if (sourceUrl)
      sourceUrl = `//# sourceURL=${this.completeUrl(sourceUrl)}`;
    return this._cdp!.Runtime.evaluate({ expression: expression + `\n${sourceUrl}` }).then(result => {
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
    await this._cdp!.Runtime.evaluate({expression: `
      new Promise(f => {
        var script = document.createElement('script');
        script.src = '${this._root.completeUrl(relativePath)}';
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

  completeUrl(relativePath: string): string {
    return this._root.completeUrl(relativePath);
  }

  workspacePath(relative: string): string {
    return this._root.workspacePath(relative);
  }

  async _init() {
    this._connection = this._root._browserLauncher.connectionForTest()!;
    const result = await this._connection.rootSession().Target.attachToBrowserTarget({});
    const testSession = this._connection.createSession(result!.sessionId);
    const { sessionId } = (await testSession.Target.attachToTarget({ targetId: this._target.id(), flatten: true }))!;
    this._cdp = this._connection.createSession(sessionId);
    await this._session._init();
    if (this._target.parent()) {
      this.dap.configurationDone({});
      this.dap.attach({});
    }
  }

  async load() {
    await this.dap.configurationDone({});
    await this.dap.attach({});
    this._cdp!.Page.enable({});
    this._cdp!.Page.navigate({ url: this._root._launchUrl! });
    await new Promise(f => this._cdp!.Page.on('loadEventFired', f));
    await this._cdp!.Page.disable({});
  }
}

export class TestRoot {
  readonly initialize: Promise<Dap.InitializeResult>;
  readonly log: Log;
  readonly assertLog: () => void;

  private _targetToP = new Map<Target, TestP>();
  private _root: Session;
  private _workspaceRoot: string;
  private _webRoot: string | undefined;
  _launchUrl: string | undefined;
  private _args: string[];
  private _blackboxPattern?: string;

  private _worker: Promise<TestP>;
  private _workerCallback: (session: TestP) => void;
  private _launchCallback: (session: TestP) => void;

  _browserLauncher: BrowserLauncher;
  readonly binder: Binder;

  private _onSessionCreatedEmitter = new EventEmitter<TestP>();
  readonly onSessionCreated = this._onSessionCreatedEmitter.event;

  constructor(goldenText: GoldenText) {
    this._args = ['--headless'];
    this.log = goldenText.log.bind(goldenText);
    this.assertLog = goldenText.assertLog.bind(goldenText);
    this._workspaceRoot = utils.platformPathToPreferredCase(path.join(__dirname, '..', '..', '..', 'testWorkspace'));
    this._webRoot = path.join(this._workspaceRoot, 'web');

    this._root = new Session();
    this._root.adapterConnection.dap().then(dap => {
      dap.on('initialize', async () => {
        dap.initialized({});
        return DebugAdapter.capabilities();
      });
      dap.on('configurationDone', async () => {
        return {};
      });
    });

    const storagePath = path.join(__dirname, '..', '..');
    this._browserLauncher = new BrowserLauncher(storagePath);
    this.binder = new Binder(this, this._root.adapterConnection, [this._browserLauncher], '0');

    this.initialize = this._root._init();

    this._launchCallback = () => {};
    this._workerCallback = () => {};
    this._worker = new Promise(f => this._workerCallback = f);
  }

  async acquireDap(target: Target): Promise<DapConnection> {
    if (this._blackboxPattern)
      target.blackboxPattern = () => this._blackboxPattern;

    const p = new TestP(this, target);
    this._targetToP.set(target, p);
    return p._session.adapterConnection;
  }

  async initAdapter(adapter: DebugAdapter, target: Target): Promise<boolean> {
    const p = this._targetToP.get(target);
    if (p) {
      adapter.breakpointManager.setPredictorDisabledForTest(true);
      adapter.sourceContainer.setSourceMapTimeouts({
        load: 0,
        resolveLocation: 2000,
        scriptPaused: 1000,
        output: 3000,
      });
      p._adapter = adapter;
      await p._init();
      if (target.parent())
        this._workerCallback(p);
      else
        this._launchCallback(p);
      this._onSessionCreatedEmitter.fire(p);
    }
    return false;
  }

  releaseDap(target: Target) {
    this._targetToP.delete(target);
  }

  setArgs(args: string[]) {
    this._args = args;
  }

  setBlackboxPattern(blackboxPattern?: string) {
    this._blackboxPattern = blackboxPattern;
  }

  worker(): Promise<TestP> {
    return this._worker;
  }

  async _launch(url: string): Promise<TestP> {
    await this.initialize;
    this._launchUrl = url;
    this._root.dap.launch({
      ...chromeLaunchConfigDefaults,
      url,
      runtimeArgs: this._args,
      webRoot: this._webRoot,
      rootPath: this._workspaceRoot,
      skipNavigateForTest: true
    } as IChromeLaunchConfiguration);
    return new Promise(f => this._launchCallback = f);
  }

  async launch(content: string): Promise<TestP> {
    const url = 'data:text/html;base64,' + Buffer.from(content).toString('base64');
    return this._launch(url);
  }

  async launchAndLoad(content: string): Promise<TestP> {
    const url = 'data:text/html;base64,' + Buffer.from(content).toString('base64');
    const p = await this._launch(url);
    await p.load();
    return p;
  }

  async launchUrl(url: string): Promise<TestP> {
    url = utils.completeUrl('http://localhost:8001/', url) || url;
    return await this._launch(url);
  }

  async launchUrlAndLoad(url: string): Promise<TestP> {
    url = utils.completeUrl('http://localhost:8001/', url) || url;
    const p = await this._launch(url);
    await p.load();
    return p;
  }

  async disconnect(): Promise<void> {
    return new Promise<void>(cb => {
      this.initialize.then(() => {
        const connection = this._browserLauncher.connectionForTest();
        if (connection) {
          const disposable = connection.onDisconnected(() => {
            cb();
            disposable.dispose();
          });
        } else {
          cb();
        }
        this._root.dap.disconnect({});
      });
    });
  }

  completeUrl(relativePath: string): string {
    return utils.completeUrl(this._launchUrl, relativePath) || '';
  }

  workspacePath(relative: string): string {
    return path.join(this._workspaceRoot, relative);
  }
}

/**
 * Recursive structure that lists folders/files and describes their contents.
 */
export interface IFileTree {
  [directoryOrFile: string]: string | Buffer | IFileTree;
}

/**
 * Creates a file tree at the given location. Primarily useful for creating
 * fixtures in unit tests.
 */
export function createFileTree(rootDir: string, tree: IFileTree) {
  mkdirp.sync(rootDir);

  for (const key of Object.keys(tree)) {
    const value = tree[key];
    const targetPath = path.join(rootDir, key);
    if (typeof value !== 'string' && !(value instanceof Buffer)) {
      createFileTree(targetPath, value);
      continue;
    }

    mkdirp.sync(path.dirname(targetPath));
    fs.writeFileSync(targetPath, value);
  }
}
