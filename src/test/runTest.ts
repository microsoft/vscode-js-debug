/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { runTests } from '@vscode/test-electron';
import minimist from 'minimist';
import * as path from 'path';

async function main() {
  try {
    // The folder containing the Extension Manifest package.json
    // Passed to `--extensionDevelopmentPath`
    const extensionDevelopmentPath = path.resolve(__dirname, '..' + path.sep + '..' + path.sep);

    // The path to the extension test script
    // Passed to --extensionTestsPath
    const extensionTestsPath = path.resolve(__dirname, '.' + path.sep + 'testRunner');

    process.env.PWA_TEST_OPTIONS = JSON.stringify(minimist(process.argv.slice(2)));

    // Download VS Code, unzip it and run the integration test
    const basedir = path.resolve(__dirname, '../../..');

    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      // temporarily disabled for test failure:
      // version: 'insiders',
      launchArgs: [
        basedir,
        `--extensions-dir=${path.resolve(basedir, 'node_modules/.code-extensions')}`,
        '--disable-extension=ms-vscode.js-debug',
        '--disable-user-env-probe',
        '--disable-workspace-trust',
      ],
    });
  } catch (err) {
    console.error('Failed to run tests', err);
    process.exit(1);
  }
}

main();
