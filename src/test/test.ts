/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as stream from 'stream';
import * as path from 'path';
import DapConnection from '../dap/connection';
import {ConfigurationDoneResult, Adapter} from '../adapter/adapter';
import Dap from '../dap/api';
import Cdp from '../cdp/api';
import CdpConnection from '../cdp/connection';
import { ChromeAdapter } from '../chrome/chromeAdapter';

export const kStabilizeNames = ['id', 'threadId', 'sourceReference', 'variablesReference'];

class Stream extends stream.Duplex {
  _write(chunk: any, encoding: string, callback: (err?: Error) => void): void {
    this.push(chunk, encoding);
    callback();
  }

  _read(size: number) {
  }
}

export type Log = (value: any, title?: string, stabilizeNames?: string[]) => typeof value;
export type Params = {cdp: Cdp.Api, dap: Dap.TestApi, log: Log, initializeResult: Dap.InitializeResult};

export async function setup(): Promise<{adapter: ChromeAdapter, dap: Dap.TestApi}> {
  const testToAdapter = new Stream();
  const adapterToTest = new Stream();
  const adapterConnection = new DapConnection(testToAdapter, adapterToTest);
  const testConnection = new DapConnection(adapterToTest, testToAdapter);
  const adapter = new ChromeAdapter(adapterConnection.dap(), path.join(__dirname, '../..'), () => {});
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
    const disposable = connection.onDisconnected(() => {
      cb();
      disposable.dispose();
    });
    dap.disconnect({});
  });
}

let evaluateCounter = 0;
export async function evaluate(p: Params, expression: string) {
  ++evaluateCounter;
  p.log(`Evaluating#${evaluateCounter}: ${expression}`);
  return p.cdp.Runtime.evaluate({expression: expression + `\n//# sourceURL=eval${evaluateCounter}.js`}).then(result => {
    if (!result) {
      p.log(expression, 'Error evaluating');
      debugger;
    } else if (result.exceptionDetails) {
      p.log(result.exceptionDetails, 'Error evaluating');
      debugger;
    }
    return result;
  });
}

export async function launchAndLoad(p: Params, url: string) {
  await p.cdp.Page.enable({});
  await Promise.all([
    p.dap.launch({url}),
    new Promise(f => p.cdp.Page.on('loadEventFired', f))
  ]);
  await p.cdp.Page.disable({});
}
