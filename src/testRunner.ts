import * as stream from 'stream';
import DapConnection from './dap/connection';
import {ConfigurationDoneResult, Adapter} from './adapter/adapter';
import Dap from './dap/api';
import Cdp from './cdp/api';
import CdpConnection from './cdp/connection';

class Stream extends stream.Duplex {
  _write(chunk: any, encoding: string, callback: (err?: Error) => void): void {
    this.push(chunk, encoding);
    callback();
  }

  _read(size: number) {
  }
}

export async function setup(): Promise<{adapter: Adapter, dap: Dap.TestApi}> {
  const testToAdapter = new Stream();
  const adapterToTest = new Stream();
  const adapterConnection = new DapConnection(testToAdapter, adapterToTest);
  const testConnection = new DapConnection(adapterToTest, testToAdapter);
  const adapter = new Adapter(adapterConnection.dap());
  return {adapter, dap: testConnection.createTestApi()};
}

export function initialize(dap: Dap.TestApi) {
  return dap.initialize({
    clientID: 'cdp-test',
    adapterID: 'cdp',
    linesStartAt1: true,
    columnsStartAt1: true,
    pathFormat: 'path',
    supportsVariablePaging: true
  });
}

export async function configure(connection: CdpConnection, dap: Dap.TestApi): Promise<Cdp.Api> {
  const result = (await dap.configurationDone({}) as ConfigurationDoneResult)!;
  const targetId = result.targetId!;
  const {sessionId} = (await connection.browser().Target.attachToTarget({ targetId, flatten: true }))!;
  return connection.createSession(sessionId);
}

export function disconnect(connection: CdpConnection, dap: Dap.TestApi): Promise<void> {
  return new Promise(cb => {
    connection.on(CdpConnection.Events.Disconnected, () => {
      console.log('Disconnected');
      cb();
    });
    dap.disconnect({});
  });
}

export async function runTest(testFunc: (cdp: Cdp.Api, dap: Dap.TestApi) => any) {
  const {adapter, dap} = await setup();
  await initialize(dap);
  const connection = await adapter.testConnection();
  const cdp = await configure(connection, dap);
  console.log(`----- Running ${testFunc.name} -----`);
  await testFunc(cdp, dap);
  await disconnect(connection, dap);
  console.log(`----- Done ${testFunc.name} -----`);
}
