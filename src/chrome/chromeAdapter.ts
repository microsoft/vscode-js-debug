// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as fs from 'fs';
import * as path from 'path';
import { URL } from 'url';
import * as vscode from 'vscode';
import * as nls from 'vscode-nls';
import { DebugAdapter } from '../adapter/debugAdapter';
import * as errors from '../adapter/errors';
import { SourcePathResolver } from '../adapter/sources';
import CdpConnection from '../cdp/connection';
import Dap from '../dap/api';
import * as utils from '../utils/urlUtils';
import findChrome from './findChrome';
import * as launcher from './launcher';
import { BrowserTarget, BrowserTargetManager } from './browserTargets';
import { Target } from '../adapter/targets';

const localize = nls.loadMessageBundle();

export interface LaunchParams extends Dap.LaunchParams {
  url: string;
  webRoot?: string;
}

export class ChromeAdapter {
  static symbol = Symbol('ChromeAdapter');
  private _connection: CdpConnection;
  private _debugAdapter: DebugAdapter;
  private _storagePath: string;
  private _rootPath: string | undefined;
  private _targetManager: BrowserTargetManager;
  private _launchParams: LaunchParams;
  private _mainTarget?: BrowserTarget;
  private _disposables: vscode.Disposable[] = [];

  constructor(debugAdapter: DebugAdapter, storagePath: string, rootPath: string | undefined) {
    this._debugAdapter = debugAdapter;
    this._storagePath = storagePath;
    this._rootPath = rootPath;
    debugAdapter.addDelegate(this);
  }

  targetManager(): BrowserTargetManager {
    return this._targetManager;
  }

  adapter(): DebugAdapter {
    return this._debugAdapter;
  }

  _dispose() {
    for (const disposable of this._disposables)
      disposable.dispose();
    this._disposables = [];
  }

  connection(): CdpConnection {
    return this._connection;
  }

  async prepareLaunch(params: LaunchParams, isUnderTest: boolean): Promise<BrowserTarget | Dap.Error> {
    // params.noDebug

    // Prefer canary over stable, it comes earlier in the list.
    const executablePath = findChrome()[0];
    if (!executablePath)
      return errors.createUserError(localize('error.executableNotFound', 'Unable to find Chrome'));
    const args: string[] = [];
    if (isUnderTest) {
      args.push('--remote-debugging-port=0');
      args.push('--headless');
    }

    try {
      fs.mkdirSync(this._storagePath);
    } catch (e) {
    }
    this._connection = await launcher.launch(
      executablePath, {
        args,
        userDataDir: path.join(this._storagePath, isUnderTest ? '.headless-profile' : 'profile'),
        pipe: true,
      });
    this._connection.onDisconnected(() => { this._debugAdapter.removeDelegate(this); }, undefined, this._disposables);

    this._launchParams = params;

    this._debugAdapter[ChromeAdapter.symbol] = this;
    const pathResolver = new ChromeSourcePathResolver(this._rootPath, params.url, params.webRoot);
    this._targetManager = new BrowserTargetManager(this._debugAdapter.threadManager, this._connection, pathResolver);
    this._disposables.push(this._targetManager);

    // Note: assuming first page is our main target breaks multiple debugging sessions
    // sharing the browser instance. This can be fixed.
    this._mainTarget = await this._targetManager.waitForMainTarget();
    if (!this._mainTarget)
      return errors.createSilentError(localize('error.threadNotFound', 'Thread not found'));
    this._targetManager.onTargetRemoved((target: BrowserTarget) => {
      if (target === this._mainTarget)
        this._debugAdapter.removeDelegate(this);
    });
    return this._mainTarget;
  }

  async finishLaunch(mainTarget: BrowserTarget): Promise<void> {
    await mainTarget.cdp().Page.navigate({ url: this._launchParams.url });
  }

  async onLaunch(params: Dap.LaunchParams): Promise<Dap.LaunchResult | Dap.Error> {
    const result = await this.prepareLaunch(params as LaunchParams, false);
    if (!(result instanceof BrowserTarget))
      return result;
    await this.finishLaunch(result);
    return {};
  }

  _mainTargetNotAvailable(): Dap.Error {
    return errors.createSilentError('Page is not available');
  }

  async onTerminate(params: Dap.TerminateParams): Promise<Dap.TerminateResult | Dap.Error> {
    if (!this._mainTarget)
      return this._mainTargetNotAvailable();
    this._mainTarget.cdp().Page.navigate({ url: 'about:blank' });
    return {};
  }

  async onDisconnect(params: Dap.DisconnectParams): Promise<Dap.DisconnectResult | Dap.Error> {
    if (!this._connection)
      return errors.createSilentError('Did not initialize');
    await this._connection.browser().Browser.close({});
    return {};
  }

  async onRestart(params: Dap.RestartParams): Promise<Dap.RestartResult | Dap.Error> {
    if (!this._mainTarget)
      return this._mainTargetNotAvailable();
    await this._mainTarget.cdp().Page.navigate({ url: this._launchParams.url });
    return {};
  }

  adapterDisposed() {
    this._dispose();
  }

  targetForest(): Target[] {
    const manager = this.targetManager()
    return manager ? manager.targetForest() : [];
  }

}

class ChromeSourcePathResolver implements SourcePathResolver {
  // We map all urls under |_baseUrl| to files under |_basePath|.
  private _basePath?: string;
  private _baseUrl?: URL;
  private _rules: { urlPrefix: string, pathPrefix: string }[] = [];
  private _rootPath: string | undefined;

  constructor(rootPath: string | undefined, url: string, webRoot: string | undefined) {
    this._rootPath = rootPath;
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

  rewriteSourceUrl(sourceUrl: string): string {
    // Per source map spec, |sourceUrl| is relative to the source map's own url. However,
    // webpack emits absolute paths in some situations instead of a relative url. We check
    // whether |sourceUrl| looks like a path and belongs to the workspace.
    if (this._rootPath && sourceUrl.startsWith(this._rootPath) && !utils.isValidUrl(sourceUrl))
      return utils.absolutePathToFileUrl(sourceUrl) || sourceUrl;
    return sourceUrl;
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

  scriptUrlToUrl(url: string): string {
    return url;
  }

  shouldCheckContentHash(): boolean {
    // Chrome executes scripts retrieved from network.
    // We check content hash because served code can be different from actual files on disk.
    return true;
  }
}
