// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {TestP, Log, kStabilizeNames} from './test';
import * as path from 'path';
import * as fs from 'fs';

let suitePath = '';
let total = 0;
const failures: string[] = [];

async function runTest(testFunc: (p: TestP) => any) {
  return _runTest(async (log: Log) => {
    const p = new TestP(log);
    log('Connected');
    await p.initialize;
    await testFunc(p);
    await p.disconnect();
    log('Disconnected');
  }, testFunc.name);
}

async function runStartupTest(testFunc: (log: Log) => Promise<any>) {
  return _runTest(testFunc, testFunc.name);
}

function _log(results: string[], item: any, title?: string, stabilizeNames?: string[]): any {
  if (typeof item === 'object')
    return _logObject(results, item, title, stabilizeNames);
  results.push((title || '') + item);
  return item;
}

function _logObject(results: string[], object: Object, title?: string, stabilizeNames?: string[]): any {
  stabilizeNames = stabilizeNames || kStabilizeNames;
  const lines: string[] = [];

  function dumpValue(value, prefix, prefixWithName) {
    if (typeof value === 'object' && value !== null) {
      if (value instanceof Array)
        dumpItems(value, prefix, prefixWithName);
      else
        dumpProperties(value, prefix, prefixWithName);
    } else {
      lines.push(prefixWithName + String(value).replace(/\n/g, ' ').replace(/VM\d+/g, 'VM<xx>'));
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
  return object;
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
  } else if (process.env.RESET_RESULTS) {
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
  const tests = testSuite.default;
  for (const s of tests.startup || [])
    await runStartupTest(s);
  for (const t of tests.tests || [])
    await runTest(t);
}

async function report() {
  console.log(`===== Failed: ${failures.length} of ${total}`);
  for (const failure of failures)
    console.log(`----- [FAIL] ${failure}`);
}

export async function run(): Promise<void> {
  await suite('infra/infra');
  await suite('stepping/pause');
  await suite('stepping/threads');
  await suite('stepping/scopes');
  await suite('evaluate/evaluate');
  await report();
}
