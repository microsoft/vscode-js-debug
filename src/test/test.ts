import * as stream from 'stream';
import * as path from 'path';
import * as fs from 'fs';
import DapConnection from '../dap/connection';
import {ConfigurationDoneResult, Adapter} from '../adapter/adapter';
import Dap from '../dap/api';
import Cdp from '../cdp/api';
import CdpConnection from '../cdp/connection';

class Stream extends stream.Duplex {
  _write(chunk: any, encoding: string, callback: (err?: Error) => void): void {
    this.push(chunk, encoding);
    callback();
  }

  _read(size: number) {
  }
}

export type Log = (value: any, title?: string, stabilizeNames?: string[]) => void;
export type Params = {cdp: Cdp.Api, dap: Dap.TestApi, log: Log};

let suitePath = '';
let total = 0;
const failures: string[] = [];

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
    connection.on(CdpConnection.Events.Disconnected, cb);
    dap.disconnect({});
  });
}

export async function runTest(testFunc: (params: Params) => any) {
  return _runTest(async (log: Log) => {
    const {adapter, dap} = await setup();
    log('Connected');
    await initialize(dap);
    const connection = await adapter.testConnection();
    const cdp = await configure(connection, dap);
    await testFunc({cdp, dap, log});
    await disconnect(connection, dap);
    log('Disconnected');
  }, testFunc.name);
}

export async function runStartupTest(testFunc: (log: Log) => Promise<any>) {
  return _runTest(testFunc, testFunc.name);
}

function _log(results: string[], item: any, title?: string, stabilizeNames?: string[]) {
  if (typeof item === 'object')
    return _logObject(results, item, title, stabilizeNames);
  results.push('' + item);
}

function _logObject(results: string[], object: Object, title?: string, stabilizeNames?: string[]) {
  stabilizeNames = stabilizeNames || ['id', 'threadId', 'sourceReference'];
  const lines: string[] = [];

  function dumpValue(value, prefix, prefixWithName) {
    if (typeof value === 'object' && value !== null) {
      if (value instanceof Array)
        dumpItems(value, prefix, prefixWithName);
      else
        dumpProperties(value, prefix, prefixWithName);
    } else {
      lines.push(prefixWithName + String(value).replace(/\n/g, ' '));
    }
  }

  function dumpProperties(object, prefix, firstLinePrefix) {
    prefix = prefix || '';
    firstLinePrefix = firstLinePrefix || prefix;
    lines.push(firstLinePrefix + '{');

    var propertyNames = Object.keys(object);
    propertyNames.sort();
    for (var i = 0; i < propertyNames.length; ++i) {
      var name = propertyNames[i];
      if (!object.hasOwnProperty(name))
        continue;
      var prefixWithName = '    ' + prefix + name + ' : ';
      var value = object[name];
      if (stabilizeNames && stabilizeNames.includes(name))
        value = `<${typeof value}>`;
      dumpValue(value, '    ' + prefix, prefixWithName);
    }
    lines.push(prefix + '}');
  }

  function dumpItems(object, prefix, firstLinePrefix) {
    prefix = prefix || '';
    firstLinePrefix = firstLinePrefix || prefix;
    lines.push(firstLinePrefix + '[');
    for (var i = 0; i < object.length; ++i)
      dumpValue(object[i], '    ' + prefix, '    ' + prefix + '[' + i + '] : ');
    lines.push(prefix + ']');
  }

  dumpValue(object, '', title || '');
  results.push(...lines);
}

async function _runTest(testFunc: (log: Log) => Promise<any>, testName: string) {
  const name = `${suitePath}-${testName}`;
  console.log(`----- [RUN] ${name}`);
  const results: string[] = [];
  const log = _log.bind(null, results);
  try {
    await testFunc(log);
  } catch (e) {
    results.push(e.toString());
  }
  results.push('');
  const output = results.join('\n');
  const fileName = path.join(__dirname, '../../src/test', suitePath + '-' + testName + '.txt');
  let success = true;
  if (!fs.existsSync(fileName)) {
    console.log(`----- Missing expectations file, writing a new one`);
    fs.writeFileSync(fileName, output, {encoding: 'utf-8'});
  } else if (process.argv.includes('--reset-results')) {
    console.log(`----- Writing expectations`);
    fs.writeFileSync(fileName, output, {encoding: 'utf-8'});
  } else {
    const expectations = fs.readFileSync(fileName).toString('utf-8');
    success = output === expectations;
  }
  if (!success)
    failures.push(name);
  total++;
  console.log(`----- ${success ? '[PASS]' : '[FAIL]'} ${name}`);
}

export async function suite(s: string) {
  suitePath = s;
  const testSuite = await import('./' + suitePath) as any;
  await testSuite.default();
}

export async function report() {
  console.log(`===== Failed: ${failures.length} of ${total}`);
  for (const failure of failures)
    console.log(`----- [FAIL] ${failure}`);
}
