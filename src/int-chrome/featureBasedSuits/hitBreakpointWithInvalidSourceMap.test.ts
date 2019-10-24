// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { testUsing } from '../fixtures/testUsing';
import { TestProjectSpec } from '../framework/frameworkTestSupport';
import { LaunchProject } from '../fixtures/launchProject';

testUsing.skip(
  'Hit breakpoint on JavaScript when source map is invalid',
  context =>
    LaunchProject.launch(context, TestProjectSpec.fromTestPath('featuresTests/invalidSourceMap')),
  async launchProject => {
    const runCodeButton = await launchProject.page.waitForSelector('#runCode');
    const breakpoint = await launchProject.breakpoints
      .at('../app.js')
      .breakpoint({ text: `console.log('line 5');` });

    await breakpoint.assertIsHitThenResumeWhen(() => runCodeButton.click(), {
      stackTrace: `
                runCode [app.js] Line 11:5 // Because the source-map is invalid we hit in app.js:11:5 instead of app.ts:5`,
    });
  },
);
