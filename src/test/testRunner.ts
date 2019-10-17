// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import Mocha from 'mocha';
import { use } from 'chai';
import { join } from 'path';

use(require('chai-subset'));

export async function run(): Promise<void> {
  const runner = new Mocha({
    timeout: 20000,
    ...JSON.parse(process.env.PWA_TEST_OPTIONS || '{}'),
  });

  runner.useColors(true);

  // todo: retry failing tests https://github.com/microsoft/vscode-pwa/issues/28
  runner.retries(2);

  runner.addFile(join(__dirname, 'testIntegrationUtils'));
  runner.addFile(join(__dirname, 'infra/infra'));
  runner.addFile(join(__dirname, 'breakpoints/breakpointsTest'));
  runner.addFile(join(__dirname, 'browser/framesTest'));
  runner.addFile(join(__dirname, 'evaluate/evaluate'));
  runner.addFile(join(__dirname, 'sources/sourcesTest'));
  runner.addFile(join(__dirname, 'stacks/stacksTest'));
  runner.addFile(join(__dirname, 'threads/threadsTest'));
  runner.addFile(join(__dirname, 'variables/variablesTest'));
  runner.addFile(join(__dirname, 'console/consoleFormatTest'));
  runner.addFile(join(__dirname, 'console/consoleAPITest'));
  runner.addFile(join(__dirname, 'extension/nodeConfigurationProvidersTests'));

  return new Promise((resolve, reject) =>
    runner.run(failures => (failures ? reject(new Error(`${failures} tests failed`)) : resolve())),
  );
}
