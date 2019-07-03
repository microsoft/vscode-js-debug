import * as vscode from 'vscode';
import * as Net from 'net';
import DapConnection from './dap/connection';
import {Adapter} from './adapter/adapter';

export class AdapterFactory implements vscode.DebugAdapterDescriptorFactory {
  readonly context: vscode.ExtensionContext;
  private _sessions = new Map<vscode.DebugSession, {server: Net.Server, adapter: Adapter}>();
  private _disposables: vscode.Disposable[];
  private _activeAdapter?: Adapter;

  private _onAdapterAddedEmitter: vscode.EventEmitter<Adapter> = new vscode.EventEmitter<Adapter>();
  private _onAdapterRemovedEmitter: vscode.EventEmitter<Adapter> = new vscode.EventEmitter<Adapter>();
  readonly onAdapterAdded: vscode.Event<Adapter> = this._onAdapterAddedEmitter.event;
  readonly onAdapterRemoved: vscode.Event<Adapter> = this._onAdapterRemovedEmitter.event;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory('cdp', this));
    context.subscriptions.push(this);

    this._disposables = [
      vscode.debug.onDidTerminateDebugSession(session => {
        const value = this._sessions.get(session);
        this._sessions.delete(session);
        if (value) {
          value.server.close();
          this._onAdapterRemovedEmitter.fire(value.adapter);
        }
      }),
      vscode.debug.onDidChangeActiveDebugSession(session => {
        const value = session ? this._sessions.get(session) : undefined;
        if (value)
          this._activeAdapter = value.adapter;
        else
          this._activeAdapter = undefined;
      }),
      this._onAdapterAddedEmitter,
      this._onAdapterRemovedEmitter,
    ];
  }

  activeAdapter(): Adapter | undefined {
    return this._activeAdapter;
  }

  adapters(): Adapter[] {
    return Array.from(this._sessions.values()).map(v => v.adapter);
  }

  createDebugAdapterDescriptor(session: vscode.DebugSession, executable: vscode.DebugAdapterExecutable | undefined): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
    const server = Net.createServer(socket => {
      const connection = new DapConnection(socket, socket);
      const adapter = new Adapter(connection.dap(), this.context.storagePath || this.context.extensionPath);
      this._sessions.set(session, {server, adapter});
      this._onAdapterAddedEmitter.fire(adapter);
    }).listen(0);
    return new vscode.DebugAdapterServer(server.address().port);
  }

  dispose() {
    for (const [session, value] of this._sessions) {
      this._sessions.delete(session);
      value.server.close();
      this._onAdapterRemovedEmitter.fire(value.adapter);
    }
    for (const disposable of this._disposables)
      disposable.dispose();
    this._disposables = [];
  }
}
