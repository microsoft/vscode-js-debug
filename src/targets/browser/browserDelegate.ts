// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as fs from 'fs';
import * as path from 'path';
import { URL } from 'url';
import * as vscode from 'vscode';
import * as nls from 'vscode-nls';
import * as errors from '../../dap/errors';
import CdpConnection from '../../cdp/connection';
import Dap from '../../dap/api';
import * as utils from '../../utils/urlUtils';
import findBrowser from './findBrowser';
import * as launcher from './launcher';
import { BrowserTarget, BrowserTargetManager } from './browserTargets';
import { Target, Launcher } from '../../targets/targets';
import Cdp from '../../cdp/api';
import { SourcePathResolver } from '../../common/sourcePathResolver';

const localize = nls.loadMessageBundle();

export interface LaunchParams extends Dap.LaunchParams {
  url: string;
  webRoot?: string;
}

export class BrowserLauncher implements Launcher {
  static symbol = Symbol('BrowserDelegate');
  private _connectionForTest: CdpConnection | undefined;
  private _storagePath: string;
  private _rootPath: string | undefined;
  private _targetManager: BrowserTargetManager | undefined;
  private _launchParams: LaunchParams | undefined;
  private _mainTarget?: BrowserTarget;
  private _disposables: vscode.Disposable[] = [];
  private _browserSession: Cdp.Api | undefined;
  private _onTerminatedEmitter = new vscode.EventEmitter<void>();
  readonly onTerminated = this._onTerminatedEmitter.event;
  private _onTargetListChangedEmitter = new vscode.EventEmitter<void>();
  readonly onTargetListChanged = this._onTargetListChangedEmitter.event;

  constructor(storagePath: string, rootPath: string | undefined) {
    this._storagePath = storagePath;
    this._rootPath = rootPath;
  }

  targetManager(): BrowserTargetManager | undefined {
    return this._targetManager;
  }

  dispose() {
    for (const disposable of this._disposables)
      disposable.dispose();
    this._disposables = [];
  }

  async prepareLaunch(params: LaunchParams, args: string[]): Promise<BrowserTarget | Dap.Error> {
    // params.noDebug

    // Prefer canary over stable, it comes earlier in the list.
    const executablePath = findBrowser()[0];
    if (!executablePath)
      return errors.createUserError(localize('error.executableNotFound', 'Unable to find browser'));

    try {
      fs.mkdirSync(this._storagePath);
    } catch (e) {
    }
    const connection = await launcher.launch(
      executablePath, {
        args,
        userDataDir: path.join(this._storagePath, args.indexOf('--headless') !== -1 ? '.headless-profile' : '.profile'),
        pipe: true,
      });
    connection.onDisconnected(() => {
      this._onTerminatedEmitter.fire();
    }, undefined, this._disposables);
    this._connectionForTest = connection;

    const rootSession = connection.rootSession();
    const result = await rootSession.Target.attachToBrowserTarget({});
    if (!result)
      return errors.createUserError(localize('error.executableNotFound', 'Unable to attach to the browser'));

    this._browserSession = connection.createSession(result.sessionId);
    this._launchParams = params;

    const pathResolver = new BrowserSourcePathResolver(params.url, params.webRoot || this._rootPath);
    this._targetManager = new BrowserTargetManager(connection, this._browserSession, pathResolver);
    this._targetManager.serviceWorkerModel.onDidChange(() => this._onTargetListChangedEmitter.fire());
    this._targetManager.frameModel.onFrameNavigated(() => this._onTargetListChangedEmitter.fire());
    this._disposables.push(this._targetManager);

    this._targetManager.onTargetAdded((target: BrowserTarget) => {
      this._onTargetListChangedEmitter.fire();
    });
    this._targetManager.onTargetRemoved((target: BrowserTarget) => {
      this._onTargetListChangedEmitter.fire();
    });

    // Note: assuming first page is our main target breaks multiple debugging sessions
    // sharing the browser instance. This can be fixed.
    this._mainTarget = await this._targetManager.waitForMainTarget();
    if (!this._mainTarget)
      return errors.createSilentError(localize('error.threadNotFound', 'Thread not found'));
    this._targetManager.onTargetRemoved((target: BrowserTarget) => {
      if (target === this._mainTarget)
        this._onTerminatedEmitter.fire();
    });
    return this._mainTarget;
  }

  async finishLaunch(mainTarget: BrowserTarget): Promise<void> {
    await mainTarget.cdp().Page.navigate({ url: this._launchParams!.url });
  }

  async launch(params: any): Promise<void> {
    if (!('url' in params))
      return;
    const result = await this.prepareLaunch(params as LaunchParams, []);
    if (!(result instanceof BrowserTarget))
      return;
    await this.finishLaunch(result);
  }

  _mainTargetNotAvailable(): Dap.Error {
    return errors.createSilentError('Page is not available');
  }

  async terminate(): Promise<void> {
    if (this._mainTarget)
      this._mainTarget.cdp().Page.navigate({ url: 'about:blank' });
  }

  async disconnect(): Promise<void> {
    if (this._browserSession)
      await this._browserSession.Browser.close({});
  }

  async restart(): Promise<void> {
    if (this._mainTarget)
      await this._mainTarget.cdp().Page.navigate({ url: this._launchParams!.url });
  }

  targetList(): Target[] {
    const manager = this.targetManager()
    return manager ? manager.targetList() : [];
  }

  connectionForTest(): CdpConnection | undefined {
    return this._connectionForTest;
  }

  predictBreakpoints(params: Dap.SetBreakpointsParams): Promise<void> {
    return Promise.resolve();
  }
}

class BrowserSourcePathResolver implements SourcePathResolver {
  // We map all urls under |_baseUrl| to files under |_basePath|.
  private _basePath?: string;
  private _baseUrl?: URL;
  private _rules: { urlPrefix: string, pathPrefix: string }[] = [];

  constructor(url: string, webRoot: string | undefined) {
    this._basePath = webRoot ? path.normalize(webRoot) : undefined;
    try {
      this._baseUrl = new URL(url);
      this._baseUrl.pathname = '/';
      this._baseUrl.search = '';
      this._baseUrl.hash = '';
      if (this._baseUrl.protocol === 'data:')
        this._baseUrl = undefined;
    } catch (e) {
      this._baseUrl = undefined;
    }

    if (!this._basePath)
      return;
    const substitute = (s: string): string => {
      return s.replace(/{webRoot}/g, this._basePath!);
    };
    this._rules = [
      { urlPrefix: 'webpack:///./~/', pathPrefix: substitute('{webRoot}/node_modules/') },
      { urlPrefix: 'webpack:///./', pathPrefix: substitute('{webRoot}/') },
      { urlPrefix: 'webpack:///src/', pathPrefix: substitute('{webRoot}/') },
      { urlPrefix: 'webpack:///', pathPrefix: substitute('/') },
    ];
  }

  absolutePathToUrl(absolutePath: string): string | undefined {
    absolutePath = path.normalize(absolutePath);
    if (!this._baseUrl || !this._basePath || !absolutePath.startsWith(this._basePath))
      return utils.absolutePathToFileUrl(absolutePath);
    const relative = path.relative(this._basePath, absolutePath);
    try {
      return new URL(relative, this._baseUrl).toString();
    } catch (e) {
    }
  }

  urlToAbsolutePath(url: string): string {
    const absolutePath = utils.fileUrlToAbsolutePath(url);
    if (absolutePath)
      return absolutePath;

    for (const rule of this._rules) {
      if (url.startsWith(rule.urlPrefix))
        return rule.pathPrefix + url.substring(rule.pathPrefix.length);
    }

    if (!this._basePath || !this._baseUrl)
      return '';
    try {
      const u = new URL(url);
      if (u.origin !== this._baseUrl.origin)
        return '';
      const pathname = path.normalize(u.pathname);
      let basepath = path.normalize(this._baseUrl.pathname);
      if (!basepath.endsWith(path.sep))
        basepath += '/';
      if (!pathname.startsWith(basepath))
        return '';
      let relative = basepath === pathname ? '' : path.normalize(path.relative(basepath, pathname));
      if (relative === '' || relative === '/')
        relative = 'index.html';
      return path.join(this._basePath, relative);
    } catch (e) {
      return '';
    }
  }
}
