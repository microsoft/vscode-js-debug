/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { isUtf8 } from 'buffer';
import { inject, injectable } from 'inversify';
import * as vscode from 'vscode';
import Cdp from '../cdp/api';
import {
  Commands,
  Configuration,
  ContextKey,
  CustomViews,
  DebugType,
  networkFilesystemScheme,
  readConfig,
  registerCommand,
  setContextKey,
} from '../common/contributionUtils';
import { DisposableList, noOpDisposable } from '../common/disposable';
import { IMirroredNetworkEvents, mirroredNetworkEvents } from '../common/networkEvents';
import { assertNever, once } from '../common/objUtils';
import Dap from '../dap/api';
import { IExtensionContribution } from '../ioc-extras';
import { DebugSessionTracker } from './debugSessionTracker';

type NetworkNode = NetworkRequest;

@injectable()
export class NetworkTree implements IExtensionContribution, vscode.TreeDataProvider<NetworkNode> {
  private readonly disposables = new DisposableList();
  private readonly activeListeners = new DisposableList();
  private readonly treeDataChangeEmitter = new vscode.EventEmitter<
    void | NetworkNode | NetworkNode[] | null | undefined
  >();
  private readonly models = new Map<string, NetworkModel>();
  private current: NetworkModel | undefined;

  constructor(
    @inject(DebugSessionTracker) private readonly debugSessionTracker: DebugSessionTracker,
  ) {
    this.disposables.push(
      vscode.debug.onDidChangeActiveDebugSession(() => {
        this.listenToActiveSession();
      }),
      this.debugSessionTracker.onSessionEnded(session => {
        this.models.delete(session.id);
      }),
      vscode.debug.onDidReceiveDebugSessionCustomEvent(event => {
        if (event.event === 'networkEvent') {
          this.models.get(event.session.id)?.append([event.body.event, event.body.data]);
        }
      }),
      this.debugSessionTracker.onSessionAdded(session => {
        if (!this.isEnabled()) {
          return;
        }

        session.customRequest('enableNetworking', { mirrorEvents: mirroredNetworkEvents }).then(
          () => {
            this.models.set(session.id, new NetworkModel(session));
            if (session === vscode.debug.activeDebugSession) {
              this.listenToActiveSession();
            }
          },
          () => {
            /* ignored */
          },
        );
      }),
      registerCommand(
        vscode.commands,
        Commands.NetworkViewRequest,
        async (request: NetworkRequest) => {
          const doc = await vscode.workspace.openTextDocument(request.fsUri);
          await vscode.window.showTextDocument(doc);
        },
      ),
      registerCommand(
        vscode.commands,
        Commands.NetworkCopyUri,
        async (request: NetworkRequest) => {
          await vscode.env.clipboard.writeText(request.init.request.url);
        },
      ),
      registerCommand(
        vscode.commands,
        Commands.NetworkOpenBody,
        async (request: NetworkRequest) => {
          const doc = await vscode.workspace.openTextDocument(request.fsBodyUri);
          await vscode.window.showTextDocument(doc);
        },
      ),
      registerCommand(
        vscode.commands,
        Commands.NetworkOpenBodyHex,
        async (request: NetworkRequest) => {
          await vscode.commands.executeCommand(
            'vscode.openWith',
            request.fsBodyUri,
            'hexEditor.hexedit',
          );
        },
      ),
      registerCommand(
        vscode.commands,
        Commands.NetworkReplayXHR,
        async (request: NetworkRequest) => {
          await request.session.customRequest(
            'networkCall',
            {
              method: 'replayXHR',
              params: { requestId: request.id },
            } satisfies Dap.NetworkCallParams,
          );
        },
      ),
      registerCommand(vscode.commands, Commands.NetworkClear, () => {
        for (const model of this.models.values()) {
          model.clear();
        }
        this.treeDataChangeEmitter.fire();
      }),
    );
  }

  /** @inheritdoc */
  onDidChangeTreeData = this.treeDataChangeEmitter.event;

  /** @inheritdoc */
  getTreeItem(element: NetworkNode): vscode.TreeItem | Thenable<vscode.TreeItem> {
    return element.toTreeItem();
  }

  /** @inheritdoc */
  getChildren(element?: NetworkNode | undefined): vscode.ProviderResult<NetworkNode[]> {
    if (!element && this.current) {
      return this.current.allRequests;
    }

    return [];
  }

  /** @inheritdoc */
  register(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      vscode.window.registerTreeDataProvider(CustomViews.Network, this),
      vscode.workspace.registerFileSystemProvider(
        networkFilesystemScheme,
        new FilesystemProvider(this.debugSessionTracker, this.models),
        { isCaseSensitive: true, isReadonly: true },
      ),
    );
  }

  private isEnabled() {
    return readConfig(vscode.workspace, Configuration.EnableNetworkView);
  }

  private listenToActiveSession() {
    this.activeListeners.clear();
    const model = (this.current = vscode.debug.activeDebugSession
      && this.models.get(vscode.debug.activeDebugSession.id));
    let hasRequests = !!model && model.hasRequests;
    if (model) {
      this.activeListeners.push(
        model.onDidChange(ev => {
          this.treeDataChangeEmitter.fire(ev.isNew ? undefined : ev.request);

          if (model.hasRequests && !hasRequests) {
            hasRequests = true;
            setContextKey(vscode.commands, ContextKey.NetworkAvailable, true);
          }
        }),
      );
    }

    setContextKey(vscode.commands, ContextKey.NetworkAvailable, hasRequests);
    this.treeDataChangeEmitter.fire(undefined);
  }
}

class FilesystemProvider implements vscode.FileSystemProvider {
  private readonly changeFileEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();

  /** @inheritdoc */
  public readonly onDidChangeFile = this.changeFileEmitter.event;

  constructor(
    private tracker: DebugSessionTracker,
    private readonly models: Map<string, NetworkModel>,
  ) {}

  /** @inheritdoc */
  watch(watchUri: vscode.Uri): vscode.Disposable {
    const [sessionId, requestId] = watchUri.path.split('/').slice(1);
    const model = this.models.get(sessionId);
    if (!model) {
      return noOpDisposable;
    }

    return model.onDidChange(({ request, isNew }) => {
      const uri = watchUri.with({ path: `${sessionId}/${request.id}` });
      if (isNew && !requestId) {
        this.changeFileEmitter.fire([{ type: vscode.FileChangeType.Created, uri }]);
      } else if (requestId === request.id) {
        this.changeFileEmitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
      }
    });
  }

  /** @inheritdoc */
  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const [sessionId, requestId] = uri.path.split('/').slice(1);
    const model = this.models.get(sessionId);
    if (!model) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }

    if (!requestId) {
      return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 };
    }

    const request = model.getRequest(requestId);
    if (!request) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }

    return {
      type: vscode.FileType.File,
      ctime: request.ctime,
      mtime: request.mtime,
      size: request.isComplete ? await request.body().then(b => b?.length || 0) : 0,
    };
  }

  /** @inheritdoc */
  readDirectory(): [string, vscode.FileType][] {
    return [];
  }

  /** @inheritdoc */
  createDirectory(): void {
    // no-op
  }

  /** @inheritdoc */
  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const [sessionId, requestId, aspect] = uri.path.split('/').slice(1);
    const request = this.models.get(sessionId)?.getRequest(requestId);
    if (!request) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }

    if (aspect === 'body') {
      if (!request.isComplete) {
        // we'll fire a watcher change event as this updates:
        return Buffer.from('Response is still loading...');
      }

      return (await request.body()) || Buffer.from('Body not available');
    }

    return Buffer.from(await request.toCurl(this.tracker.getById(sessionId)));
  }

  /** @inheritdoc */
  writeFile(): void {
    // no-op
  }

  /** @inheritdoc */
  delete(): void {
    // no-op
  }

  /** @inheritdoc */
  rename(): void {
    // no-op
  }
}

class NetworkModel {
  private readonly requests = new Map<string, NetworkRequest>();

  private readonly didChangeEmitter = new vscode.EventEmitter<{
    request: NetworkRequest;
    isNew: boolean;
  }>();
  public readonly onDidChange = this.didChangeEmitter.event;

  constructor(private readonly session: vscode.DebugSession) {}

  public get allRequests() {
    return [...this.requests.values()];
  }

  public get hasRequests() {
    return this.requests.size > 0;
  }

  public getRequest(id: string) {
    return this.requests.get(id);
  }

  public clear() {
    this.requests.clear();
  }

  public append([key, event]: KeyValue<IMirroredNetworkEvents>) {
    if (key === 'requestWillBeSent') {
      const request = new NetworkRequest(event, this.session);
      this.requests.set(event.requestId, request);
      this.didChangeEmitter.fire({ request, isNew: true });
    } else if (
      key === 'responseReceived'
      || key === 'loadingFailed'
      || key === 'loadingFinished'
      || key === 'responseReceivedExtraInfo'
    ) {
      const request = this.requests.get(event.requestId);
      if (!request) {
        return;
      }

      if (key === 'responseReceived') {
        request.response = event.response || {}; // node.js response is just empty right now
      } else if (key === 'loadingFailed') {
        request.failed = event;
      } else if (key === 'loadingFinished') {
        request.finished = event;
      } else if (key === 'responseReceivedExtraInfo') {
        request.responseExtra = event;
      }
      request.mtime = Date.now();
      this.didChangeEmitter.fire({ request, isNew: false });
    } else {
      assertNever(key, 'unexpected network event');
    }
  }
}

export class NetworkRequest {
  public readonly ctime = Date.now();
  public mtime = Date.now();
  public response?: Cdp.Network.Response;
  public responseExtra?: Cdp.Network.ResponseReceivedExtraInfoEvent;
  public failed?: Cdp.Network.LoadingFailedEvent;
  public finished?: Cdp.Network.LoadingFinishedEvent;

  public get isComplete() {
    return !!(this.finished || this.failed);
  }

  public get id() {
    return this.init.requestId;
  }

  public get fsUri() {
    return vscode.Uri.from({
      scheme: networkFilesystemScheme,
      path: `/${this.session.id}/${this.id}`,
    });
  }

  public get fsBodyUri() {
    return vscode.Uri.from({
      scheme: networkFilesystemScheme,
      path: `/${this.session.id}/${this.id}/body`,
    });
  }

  constructor(
    public readonly init: Cdp.Network.RequestWillBeSentEvent,
    public readonly session: vscode.DebugSession,
  ) {}

  /** Returns a tree-item representation of the request. */
  public toTreeItem() {
    let icon: vscode.ThemeIcon;
    if (!this.isComplete) {
      icon = new vscode.ThemeIcon(
        'sync~spin',
        new vscode.ThemeColor('notebookStatusRunningIcon.foreground'),
      );
    } else if (this.failed) {
      icon = new vscode.ThemeIcon(
        'error',
        new vscode.ThemeColor('notebookStatusErrorIcon.foreground'),
      );
    } else if (this.response && this.response.status >= 400) {
      icon = new vscode.ThemeIcon('warning');
    } else {
      icon = new vscode.ThemeIcon(
        'check',
        new vscode.ThemeColor('notebookStatusSuccessIcon.foreground'),
      );
    }

    let label = '';
    if (this.failed) {
      label += `[${this.failed.errorText}] `;
    } else if (this.response) {
      label += `[${this.response.status}] `;
    }

    let host: string | undefined;
    let path: string;
    try {
      const url = new URL(this.init.request.url);
      host = url.host;
      path = url.pathname;
    } catch {
      path = this.init.request.url;
    }

    label += `${this.init.request.method.toUpperCase()} ${path}`;
    const treeItem = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
    treeItem.iconPath = icon;
    treeItem.description = host;
    treeItem.tooltip = this.init.request.url;
    treeItem.id = this.init.requestId;
    treeItem.collapsibleState = vscode.TreeItemCollapsibleState.None;
    return treeItem;
  }

  /** Converts the request to a curl-style command. */
  public async toCurl(session: vscode.DebugSession | undefined) {
    const command = this.toCurlCommand();
    if (!this.response) {
      return command;
    }

    const parts = [command];
    parts.push(`< HTTP ${this.responseExtra?.statusCode || this.response.status || 'UNKOWN'}`);
    for (
      const header of Object.entries(
        this.responseExtra?.headers || this.response.headers || {},
      )
    ) {
      parts.push(`< ${header[0]}: ${header[1]}`);
    }
    parts.push('<');

    if (this.failed) {
      parts.push('', `${this.failed.errorText}`);
      if (this.failed.blockedReason) {
        parts.push(`Blocked: ${this.failed.blockedReason}`);
      } else if (this.failed.corsErrorStatus) {
        parts.push(`CORS error: ${this.failed.corsErrorStatus.corsError}`);
      }
    }

    if (!this.isComplete || !session) {
      return parts.join('\n');
    }

    const body = (await this.body()) || Buffer.from('');
    if (!isUtf8(body)) {
      parts.push(`[binary data as base64]: ${body.toString('base64')}`);
    } else {
      const str = body.toString();
      try {
        const parsed = JSON.parse(str);
        parts.push(JSON.stringify(parsed, null, 2));
      } catch {
        parts.push(str);
      }
    }

    return parts.join('\n');
  }

  private toCurlCommand() {
    const args = ['curl', '-v'];
    if (this.init.request.method !== 'GET') {
      args.push(`-X ${this.init.request.method}`);
    }

    // note: although headers is required by CDP types, it's undefined in Node.js right now (22.6.0)
    for (const [headerName, headerValue] of Object.entries(this.init.request.headers || {})) {
      args.push(`-H '${headerName}: ${headerValue}'`);
    }

    if (this.init.request.postDataEntries?.length) {
      const parts = this.init.request.postDataEntries.map(e => e.bytes || '').join('');
      const bytes = Buffer.from(parts, 'base64');
      args.push(isUtf8(bytes) ? `-d '${bytes.toString()}'` : `--data-binary '<data>'`);
    }

    args.push(`'${this.init.request.url}'`);

    return args.join(' ');
  }

  /** Gets the response body. */
  public body = once(async () => {
    try {
      const res: Cdp.Network.GetResponseBodyResult = await this.session.customRequest(
        'networkCall',
        {
          method: 'getResponseBody',
          params: { requestId: this.init.requestId },
        } satisfies Dap.NetworkCallParams,
      );

      if (!res.body) {
        // only say this on failure so that we gracefully support it once available:
        if (this.session.type === DebugType.Node) {
          return Buffer.from('Response body inspection is not supported in Node.js yet.');
        }
        return undefined;
      }
      if (res.base64Encoded) {
        return Buffer.from(res.body, 'base64');
      }
      return Buffer.from(res.body);
    } catch {
      return undefined;
    }
  });
}

type KeyValue<T> = keyof T extends infer K ? K extends keyof T ? [key: K, value: T[K]]
  : never
  : never;
