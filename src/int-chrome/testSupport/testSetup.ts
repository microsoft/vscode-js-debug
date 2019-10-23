/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DebugProtocol } from 'vscode-debugprotocol';

import { ExtendedDebugClient
} from './debugClient';
import { promiseTimeout, sleep } from '../testUtils';

// ES6 default export...
// tslint:disable-next-line:no-var-requires
const LoggingReporter = require('./loggingReporter');
// LoggingReporter.alwaysDumpLogs = true;

let unhandledAdapterErrors: string[];
const origTest = test;
const checkLogTest = (title: string, testCallback?: any, testFn: Function = origTest): Mocha.ITest => {
    // Hack to always check logs after a test runs, can simplify after this issue:
    // https://github.com/mochajs/mocha/issues/1635
    if (!testCallback) {
        return origTest(title, testCallback);
    }

    function runTest(): Promise<any> {
        return new Promise((resolve, reject) => {
            const optionalCallback = e => {
                if (e) reject(e);
                else resolve();
            };

            const maybeP = testCallback(optionalCallback);
            if (maybeP && maybeP.then) {
                maybeP.then(resolve, reject);
            }
        });
    }

    return testFn(title, () => {
        return runTest()
            .then(() => {
                // If any unhandled errors were logged, then ensure the test fails
                if (unhandledAdapterErrors.length) {
                    const errStr = unhandledAdapterErrors.length === 1 ? unhandledAdapterErrors[0] :
                        JSON.stringify(unhandledAdapterErrors);
                    throw new Error(errStr);
                }
            });
    });
};
(<Mocha.ITestDefinition>checkLogTest).only = (expectation, assertion) => checkLogTest(expectation, assertion, origTest.only);
(<Mocha.ITestDefinition>checkLogTest).skip = test.skip;
test = (<any>checkLogTest);

function log(e: DebugProtocol.OutputEvent): void {
    // Skip telemetry events
    if (e.body.category === 'telemetry') return;

    if (!e.body.output) return; // TODO@rob

    const timestamp = new Date().toISOString().split(/[TZ]/)[1];
    const outputBody = e.body.output ? e.body.output.trim() : 'variablesReference: ' + e.body.variablesReference;
    const msg = ` ${timestamp} ${outputBody}`;
    LoggingReporter.logEE.emit('log', msg);

    if (msg.indexOf('********') >= 0) unhandledAdapterErrors.push(msg);
}

export type PatchLaunchArgsCb = (launchArgs: any) => Promise<void> | void;

let dc: ExtendedDebugClient;
function patchLaunchFn(patchLaunchArgsCb: PatchLaunchArgsCb): void {
    function patchLaunchArgs(launchArgs): Promise<void> {
      launchArgs.request = 'launch';
        launchArgs.trace = 'verbose';
        const patchReturnVal = patchLaunchArgsCb(launchArgs);
        return patchReturnVal || Promise.resolve();
    }

    const origLaunch = dc.launch;
    dc.launch = (launchArgs: any) => {
        return patchLaunchArgs(launchArgs)
            .then(() => origLaunch.call(dc, launchArgs));
    };

    const origAttachRequest = dc.attachRequest;
    dc.attachRequest = (attachArgs: any) => {
        return patchLaunchArgs(attachArgs)
            .then(() => origAttachRequest.call(dc, attachArgs));
    };
}

export interface ISetupOpts {
    type: string;
    patchLaunchArgs?: PatchLaunchArgsCb;
    port?: number;
    alwaysDumpLogs?: boolean;
}

export function setup(opts: ISetupOpts): Promise<ExtendedDebugClient> {
    unhandledAdapterErrors = [];
    dc = new ExtendedDebugClient('node', '', opts.type); // Will always use 'port'
    if (opts.patchLaunchArgs) {
        patchLaunchFn(opts.patchLaunchArgs);
    }

    LoggingReporter.alwaysDumpLogs = opts.alwaysDumpLogs;
    dc.addListener('output', log);

    return dc.start(opts.port)
        .then(() => dc);
}

export async function teardown(): Promise<void> {
    dc.removeListener('output', log);
    await dc.stop();
}
