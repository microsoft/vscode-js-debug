import * as DAP from './dap';
import { DebugProtocol } from 'vscode-debugprotocol';

export class Adapter implements DAP.Adapter {
  private _dapConnection: DAP.Connection;

	constructor(connection: DAP.Connection) {
		this._dapConnection = connection;
		connection.setAdapter(this);
	}

	public async initialize(args: DebugProtocol.InitializeRequestArguments): Promise<DebugProtocol.Capabilities> {
		console.log('initialize', args);
		return {};
	}
}
