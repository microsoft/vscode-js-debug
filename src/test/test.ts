/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as fs from 'fs';
import * as mkdirp from 'mkdirp';
import * as path from 'path';
import * as stream from 'stream';
import { DebugAdapter } from '../adapter/debugAdapter';
import { Binder } from '../binder';
import Cdp from '../cdp/api';
import CdpConnection from '../cdp/connection';
import { EventEmitter } from '../common/events';
import * as utils from '../common/urlUtils';
import {
  chromeLaunchConfigDefaults,
  IChromeLaunchConfiguration,
  INodeAttachConfiguration,
  INodeLaunchConfiguration,
  nodeAttachConfigDefaults,
  nodeLaunchConfigDefaults,
} from '../configuration';
import Dap from '../dap/api';
import DapConnection from '../dap/connection';
import { ChromeLauncher } from '../targets/browser/chromeLauncher';
import { ITarget } from '../targets/targets';
import { GoldenText } from './goldenText';
import { Logger } from './logger';
import { getLogFileForTest } from './reporters/logReporterUtils';
import { TargetOrigin } from '../targets/targetOrigin';
import { TelemetryReporter } from '../telemetry/telemetryReporter';
import { ILogger } from '../common/logging';
import { Logger as AdapterLogger } from '../common/logging/logger';
import { createTopLevelSessionContainer, createGlobalContainer } from '../ioc';

export const kStabilizeNames = ['id', 'threadId', 'sourceReference', 'variablesReference'];

export const workspaceFolder = path.join(__dirname, '..', '..', '..');
export const testWorkspace = path.join(workspaceFolder, 'testWorkspace');
export const testSources = path.join(workspaceFolder, 'src');
export const testFixturesDirName = '.dynamic-testWorkspace';
export const testFixturesDir = path.join(workspaceFolder, testFixturesDirName);

class Stream extends stream.Duplex {
  _write(chunk: any, encoding: string, callback: (err?: Error) => void): void {
    Promise.resolve()
      .then()
      .then()
      .then()
      .then()
      .then()
      .then()
      .then()
      .then()
      .then()
      .then()
      .then(() => {
        this.push(chunk, encoding);
        callback();
      });
  }

  _read(size: number) {
    // no-op
  }
}

export type Log = (value: any, title?: string, stabilizeNames?: string[]) => typeof value;

export type AssertLog = GoldenText['assertLog'];

class Session {
  readonly dap: Dap.TestApi;
  readonly adapterConnection: DapConnection;

  constructor(logger: ILogger) {
    const testToAdapter = new Stream();
    const adapterToTest = new Stream();
    this.adapterConnection = new DapConnection(new TelemetryReporter(), logger);
    this.adapterConnection.init(testToAdapter, adapterToTest);
    const testConnection = new DapConnection(new TelemetryReporter(), logger);
    testConnection.init(adapterToTest, testToAdapter);
    this.dap = testConnection.createTestApi();
  }

  async _init(): Promise<Dap.InitializeResult> {
    await this.adapterConnection.dap();
    const [r] = await Promise.all([
      this.dap.initialize({
        clientID: 'pwa-test',
        adapterID: 'pwa',
        linesStartAt1: true,
        columnsStartAt1: true,
        pathFormat: 'path',
        supportsVariablePaging: true,
      }),
      this.dap.once('initialized'),
    ]);
    return r;
  }
}

/**
 * Test handle for a Chrome or Node debug sessions/
 */
export interface ITestHandle {
  readonly cdp: Cdp.Api;
  readonly adapter: DebugAdapter;
  readonly logger: Logger;
  readonly dap: Dap.TestApi;
  readonly log: Log;
  readonly assertLog: AssertLog;

  load(): Promise<void>;
  _init(adapter: DebugAdapter, target: ITarget): Promise<boolean>;
}

export class TestP implements ITestHandle {
  readonly dap: Dap.TestApi;
  readonly logger: Logger;
  readonly log: Log;
  readonly assertLog: AssertLog;

  _session: Session;
  _adapter?: DebugAdapter;
  private _root: TestRoot;
  private _evaluateCounter = 0;
  private _connection: CdpConnection | undefined;
  private _cdp: Cdp.Api | undefined;
  private _target: ITarget;

  constructor(root: TestRoot, target: ITarget) {
    this._root = root;
    this._target = target;
    this.log = root.log;
    this.assertLog = root.assertLog;
    this._session = new Session(root.adapterLogger);
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
    if (sourceUrl === undefined) sourceUrl = `//# sourceURL=eval${this._evaluateCounter}.js`;
    else if (sourceUrl) sourceUrl = `//# sourceURL=${this.completeUrl(sourceUrl)}`;
    return this._cdp!.Runtime.evaluate({ expression: expression + `\n${sourceUrl}` }).then(
      result => {
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
      },
    );
  }

  async addScriptTag(relativePath: string): Promise<void> {
    await this._cdp!.Runtime.evaluate({
      expression: `
      new Promise(f => {
        var script = document.createElement('script');
        script.src = '${this._root.completeUrl(relativePath)}';
        script.onload = () => f(undefined);
        document.head.appendChild(script);
      })
    `,
      awaitPromise: true,
    });
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

  async _init(adapter: DebugAdapter) {
    adapter.breakpointManager.setPredictorDisabledForTest(true);
    adapter.sourceContainer.setSourceMapTimeouts({
      load: 0,
      resolveLocation: 2000,
      scriptPaused: 1000,
      output: 3000,
    });
    this._adapter = adapter;

    this._connection = this._root._browserLauncher.connectionForTest()!;
    const result = await this._connection.rootSession().Target.attachToBrowserTarget({});
    const testSession = this._connection.createSession(result!.sessionId);
    const { sessionId } = (await testSession.Target.attachToTarget({
      targetId: this._target.id(),
      flatten: true,
    }))!;
    this._cdp = this._connection.createSession(sessionId);
    await this._session._init();
    if (this._target.parent()) {
      this.dap.configurationDone({});
      this.dap.attach({});
    }

    return false;
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

export class NodeTestHandle implements ITestHandle {
  readonly dap: Dap.TestApi;
  readonly logger: Logger;
  readonly log: Log;
  readonly assertLog: AssertLog;

  _session: Session;
  _adapter?: DebugAdapter;
  private _root: TestRoot;
  private _cdp: Cdp.Api | undefined;
  private _target: ITarget;

  constructor(root: TestRoot, target: ITarget) {
    this._root = root;
    this._target = target;
    this.log = root.log;
    this.assertLog = root.assertLog;
    this._session = new Session(root.adapterLogger);
    this.dap = this._session.dap;
    this.logger = new Logger(this.dap, this.log);
  }

  get cdp(): Cdp.Api {
    return this._cdp!;
  }

  get adapter(): DebugAdapter {
    return this._adapter!;
  }

  waitForSource(filter?: string): Promise<Dap.LoadedSourceEventParams> {
    return this.dap.once('loadedSource', event => {
      return filter === undefined || (event.source.path || '').indexOf(filter) !== -1;
    });
  }

  workspacePath(relative: string): string {
    return this._root.workspacePath(relative);
  }

  async _init(adapter: DebugAdapter, target: ITarget) {
    this._adapter = adapter;
    await this._session._init();
    if (this._target.parent()) {
      this.dap.configurationDone({});
      this.dap.attach({});
    }

    return true;
  }

  async load() {
    await this.dap.configurationDone({});
    await this.dap.attach({});
  }
}

export class TestRoot {
  readonly initialize: Promise<Dap.InitializeResult>;
  readonly log: Log;
  readonly assertLog: AssertLog;

  private _targetToP = new Map<ITarget, ITestHandle>();
  private _root: Session;
  private _workspaceRoot: string;
  private _webRoot: string | undefined;
  _launchUrl: string | undefined;
  private _args: string[];

  private _worker: Promise<ITestHandle>;
  private _workerCallback: (session: ITestHandle) => void;
  private _launchCallback: (session: ITestHandle) => void;

  _browserLauncher: ChromeLauncher;
  readonly binder: Binder;

  private _onSessionCreatedEmitter = new EventEmitter<ITestHandle>();
  readonly onSessionCreated = this._onSessionCreatedEmitter.event;
  public readonly adapterLogger = new AdapterLogger();

  constructor(goldenText: GoldenText, private _testTitlePath: string) {
    this._args = ['--headless'];
    this.log = goldenText.log.bind(goldenText);
    this.assertLog = goldenText.assertLog.bind(goldenText);
    this._workspaceRoot = utils.platformPathToPreferredCase(
      path.join(__dirname, '..', '..', '..', 'testWorkspace'),
    );
    this._webRoot = path.join(this._workspaceRoot, 'web');

    this._root = new Session(this.adapterLogger);
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
    const services = createTopLevelSessionContainer(
      createGlobalContainer({ storagePath, isVsCode: true }),
    );
    this._browserLauncher = services.get(ChromeLauncher);
    this.binder = new Binder(
      this,
      Promise.resolve(this._root.adapterConnection),
      new TelemetryReporter(),
      services,
      new TargetOrigin('0'),
    );

    this.initialize = this._root._init();

    this._launchCallback = () => {};
    this._workerCallback = () => {};
    this._worker = new Promise(f => (this._workerCallback = f));
  }

  public async acquireDap(target: ITarget): Promise<DapConnection> {
    const p = target.type() === 'page' ? new TestP(this, target) : new NodeTestHandle(this, target);
    this._targetToP.set(target, p);
    return p._session.adapterConnection;
  }

  async initAdapter(adapter: DebugAdapter, target: ITarget): Promise<boolean> {
    const p = this._targetToP.get(target);
    if (!p) {
      return true;
    }

    const boot = await p._init(adapter, target);
    if (target.parent()) this._workerCallback(p);
    else this._launchCallback(p);
    this._onSessionCreatedEmitter.fire(p);
    return boot;
  }

  releaseDap(target: ITarget) {
    this._targetToP.delete(target);
  }

  setArgs(args: string[]) {
    this._args = args;
  }

  worker(): Promise<ITestHandle> {
    return this._worker;
  }

  /**
   * Returns the root session DAP connection.
   */
  rootDap() {
    return this._root.dap;
  }

  async waitForTopLevel() {
    const result = await new Promise(f => (this._launchCallback = f));
    return result as TestP;
  }

  async _launch(url: string, options: Partial<IChromeLaunchConfiguration> = {}): Promise<TestP> {
    await this.initialize;
    this._launchUrl = url;

    const tmpLogPath = getLogFileForTest(this._testTitlePath);
    this._root.dap.launch({
      ...chromeLaunchConfigDefaults,
      url,
      runtimeArgs: this._args,
      webRoot: this._webRoot,
      rootPath: this._workspaceRoot,
      skipNavigateForTest: true,
      trace: { logFile: tmpLogPath },
      outFiles: [`${this._workspaceRoot}/**/*.js`, '!**/node_modules/**'],
      ...options,
    } as IChromeLaunchConfiguration);

    const result = await new Promise(f => (this._launchCallback = f));
    return result as TestP;
  }

  async runScript(
    filename: string,
    options: Partial<INodeLaunchConfiguration> = {},
  ): Promise<NodeTestHandle> {
    await this.initialize;
    this._launchUrl = path.isAbsolute(filename) ? filename : path.join(testFixturesDir, filename);

    const tmpLogPath = getLogFileForTest(this._testTitlePath);
    this._root.dap.launch({
      ...nodeLaunchConfigDefaults,
      cwd: path.dirname(testFixturesDir),
      program: this._launchUrl,
      rootPath: this._workspaceRoot,
      trace: { logFile: tmpLogPath },
      outFiles: [`${this._workspaceRoot}/**/*.js`, '!**/node_modules/**'],
      resolveSourceMapLocations: ['**', '!**/node_modules/**'],
      __workspaceFolder: this._workspaceRoot,
      ...options,
    } as INodeLaunchConfiguration);
    const result = await new Promise(f => (this._launchCallback = f));
    return result as NodeTestHandle;
  }

  async attachNode(
    processId: number,
    options: Partial<INodeAttachConfiguration> = {},
  ): Promise<NodeTestHandle> {
    await this.initialize;
    this._launchUrl = `process${processId}`;
    this._root.dap.launch({
      ...nodeAttachConfigDefaults,
      processId: `inspector${processId}`,
      __workspaceFolder: this._workspaceRoot,
      ...options,
    } as INodeAttachConfiguration);
    const result = await new Promise(f => (this._launchCallback = f));
    return result as NodeTestHandle;
  }

  async launch(content: string, options: Partial<IChromeLaunchConfiguration> = {}): Promise<TestP> {
    const url = 'data:text/html;base64,' + Buffer.from(content).toString('base64');
    return this._launch(url, options);
  }

  async launchAndLoad(
    content: string,
    options: Partial<IChromeLaunchConfiguration> = {},
  ): Promise<TestP> {
    const url = 'data:text/html;base64,' + Buffer.from(content).toString('base64');
    const p = await this._launch(url, options);
    await p.load();
    return p;
  }

  async launchUrl(url: string, options: Partial<IChromeLaunchConfiguration> = {}): Promise<TestP> {
    url = utils.completeUrl('http://localhost:8001/', url) || url;
    return await this._launch(url, options);
  }

  async launchUrlAndLoad(
    url: string,
    options: Partial<IChromeLaunchConfiguration> = {},
  ): Promise<TestP> {
    url = utils.completeUrl('http://localhost:8001/', url) || url;
    const p = await this._launch(url, options);
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
  [directoryOrFile: string]: string | string[] | Buffer | IFileTree;
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

    let write: Buffer;
    if (typeof value === 'string') {
      write = Buffer.from(value);
    } else if (value instanceof Buffer) {
      write = value;
    } else if (value instanceof Array) {
      write = Buffer.from(value.join('\n'));
    } else {
      createFileTree(targetPath, value);
      continue;
    }

    mkdirp.sync(path.dirname(targetPath));
    fs.writeFileSync(targetPath, write);
  }
}
