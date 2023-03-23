/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

const { runTests } = require('@vscode/test-electron');
const minimist = require('minimist');
const path = require('path');

async function main() {
  try {
    // The folder containing the Extension Manifest package.json
    // Passed to `--extensionDevelopmentPath`
    const extensionDevelopmentPath = path.resolve(__dirname, '../../dist');

    // The path to the extension test script
    // Passed to --extensionTestsPath
    const extensionTestsPath = path.resolve(extensionDevelopmentPath, 'src/testRunner');

    process.env.PWA_TEST_OPTIONS = JSON.stringify(minimist(process.argv.slice(2)));

    // Download VS Code, unzip it and run the integration test
    const basedir = path.resolve(__dirname, '../..');

    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [
        basedir,
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
