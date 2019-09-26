// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as net from 'net';
import * as queryString from 'querystring';
import * as vscode from 'vscode';
import { DebugAdapter } from './adapter/debugAdapter';
import { Source, UiLocation } from './adapter/sources';
import { Binder, BinderDelegate } from './binder';
import Dap from './dap/api';
import DapConnection from './dap/connection';
import { SessionManager } from './sessionManager';
import { BrowserLauncher } from './targets/browser/browserLauncher';
import { NodeLauncher, ProgramLauncher } from './targets/node/nodeLauncher';
import { BrowserAttacher } from './targets/browser/browserAttacher';
import { Target } from './targets/targets';
import { Disposable, EventEmitter } from './utils/eventUtils';
import { checkVersion } from './version';
import { FileSourcePathResolver } from './common/sourcePathResolver';

class TerminalProgramLauncher implements ProgramLauncher {
  private _terminal: vscode.Terminal | undefined;
  private _onProgramStoppedEmitter = new EventEmitter<void>();
  public onProgramStopped = this._onProgramStoppedEmitter.event;
  private _disposable: Disposable;

  constructor() {
    this._disposable = vscode.window.onDidCloseTerminal(terminal => {
      if (terminal === this._terminal)
        this._onProgramStoppedEmitter.fire();
    });
  }

  launchProgram(name: string, cwd: string | undefined, env: { [key: string]: string | null }, command: string): void {
    this._terminal = vscode.window.createTerminal({
      name: name || 'Debugger terminal',
      cwd,
      env
    });
    this._terminal.show();
    if (command)
      this._terminal.sendText(command, true);
  }

  stopProgram(): void {
    if (!this._terminal)
      return;
    this._terminal.dispose();
    this._terminal = undefined;
  }

  dispose() {
    this.stopProgram();
    this._disposable.dispose();
  }
}

export class Session implements Disposable {
  private _server: net.Server;
  private _debugAdapter?: DebugAdapter;
  private _binder?: Binder;
  private _onTargetNameChanged?: Disposable;

  constructor(context: vscode.ExtensionContext, debugSession: vscode.DebugSession, target: Target | undefined, binderDelegate: BinderDelegate | undefined, callback: (debugAdapter: DebugAdapter) => void) {
    if (target && checkVersion('1.39.0'))
      this._onTargetNameChanged = target.onNameChanged(() => debugSession.name = target.name());

    this._server = net.createServer(async socket => {
      let rootPath = vscode.workspace.rootPath;
      if (debugSession.workspaceFolder && debugSession.workspaceFolder.uri.scheme === 'file:')
        rootPath = debugSession.workspaceFolder.uri.path;

      const connection = new DapConnection(socket, socket);
      this._debugAdapter = new DebugAdapter(connection.dap(), rootPath, target ? target.sourcePathResolver() : new FileSourcePathResolver(rootPath), {
        copyToClipboard: text => vscode.env.clipboard.writeText(text),
        revealUiLocation: async (uiLocation: UiLocation) => {
          const position = new vscode.Position(uiLocation.lineNumber - 1, uiLocation.columnNumber - 1);
          const dap = await uiLocation.source.toDap();
          let uri: vscode.Uri;
          if (!dap.sourceReference) {
            uri = vscode.Uri.file(dap.path!);
          } else {
            uri = vscode.Uri.parse(`debug:${encodeURIComponent(dap.path!)}?session=${encodeURIComponent(debugSession.id)}&ref=${dap.sourceReference}`);
          }
          vscode.window.showTextDocument(uri, {selection: new vscode.Range(position, position)});
        }
      });

      if (binderDelegate) {
        const launchers = [
          new NodeLauncher(this._debugAdapter.sourceContainer.rootPath, new TerminalProgramLauncher()),
          new BrowserLauncher(context.storagePath || context.extensionPath, this._debugAdapter.sourceContainer.rootPath),
          new BrowserAttacher(this._debugAdapter.sourceContainer.rootPath),
        ];
        this._binder = new Binder(binderDelegate, this._debugAdapter, launchers, debugSession.id);
      }

      callback(this._debugAdapter);
    }).listen(0);
  }

  descriptor(): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
    return new vscode.DebugAdapterServer(this._server.address().port);
  }

  dispose() {
    if (this._binder)
      this._binder.dispose();
    if (this._debugAdapter)
      this._debugAdapter.dispose();
    if (this._onTargetNameChanged)
      this._onTargetNameChanged.dispose();
    this._server.close();
  }
}

export class AdapterFactory implements vscode.DebugAdapterDescriptorFactory, Disposable {
  private _context: vscode.ExtensionContext;
  private _disposables: Disposable[];
  private _sessions = new Map<string, Session>();
  private _sessionManager: SessionManager;

  constructor(context: vscode.ExtensionContext) {
    this._context = context;
    context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory('pwa', this));
    context.subscriptions.push(this);
    this._disposables = [];
    this._sessionManager = new SessionManager();

    vscode.debug.onDidTerminateDebugSession(debugSession => {
      const session = this._sessions.get(debugSession.id);
      if (!session)
        return;
      this._sessions.delete(debugSession.id);
      session.dispose();
    }, undefined, this._disposables);
  }

  createDebugAdapterDescriptor(debugSession: vscode.DebugSession, executable: vscode.DebugAdapterExecutable | undefined): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
    const session = this._sessionManager.createSession(this._context, debugSession, debugAdapter => {});
    this._sessions.set(debugSession.id, session);
    return session.descriptor();
  }

  dispose() {
    for (const session of this._sessions.values())
      session.dispose();
    this._sessions.clear();
    this._sessionManager.dispose();
    for (const disposable of this._disposables)
      disposable.dispose();
    this._disposables = [];
  }
}
