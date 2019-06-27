import * as stream from 'stream';
import DapConnection from './dap/connection';
import {Adapter} from './adapter/adapter';
import Dap from './dap/api';

class Stream extends stream.Duplex {
  _write(chunk: any, encoding: string, callback: (err?: Error) => void): void {
    this.push(chunk, encoding);
    callback();
  }

  _read(size: number) {
  }
}

function setup() {
  const testToAdapter = new Stream();
  const adapterToTest = new Stream();
  const adapterConnection = new DapConnection(testToAdapter, adapterToTest);
  const testConnection = new DapConnection(adapterToTest, testToAdapter);
  const adapter = new Adapter(adapterConnection.dap());
  return {adapter, dap: testConnection.createTestApi()};
}

function initialize(dap: Dap.TestApi) {
  return dap.initialize({
    clientID: 'cdp-test',
    adapterID: 'cdp',
    linesStartAt1: true,
    columnsStartAt1: true,
    pathFormat: 'path',
    supportsVariablePaging: true
  });
}

async function testInitialize() {
  const {adapter, dap} = setup();
  dap.on('initialized', console.log('initialized'));
  console.log(await initialize(dap));
}

async function runTests() {
  await testInitialize();
  console.log('All done');
  process.exit(0);
}

runTests();
