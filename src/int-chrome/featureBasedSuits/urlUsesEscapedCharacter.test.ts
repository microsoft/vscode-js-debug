// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { testUsing } from '../fixtures/testUsing';
import { TestProjectSpec } from '../framework/frameworkTestSupport';
import { LaunchProject } from '../fixtures/launchProject';
import { pathToFileURL } from '../testUtils';

const testSpec = TestProjectSpec.fromTestPath('simple');
const appPath = testSpec.src('../index.html');

// appPathUrl will have on Windows a character escaped like file:///C%3A/myproject/index.html
const appPathUrl = pathToFileURL(appPath).replace(/file:\/\/\/([a-z]):\//, 'file:///$1%3A/');

suite('Unusual launch.json', () => {
  testUsing(
    'Hit breakpoint when using an escape character in the url',
    context => LaunchProject.launch(context, testSpec.usingStaticUrl(appPathUrl)),
    async launchProject => {
      // Wait for the page to load
      await launchProject.page.waitForSelector('#helloWorld');

      // Set a breakpoint, and reload to hit the breakpoint
      const breakpoint = await launchProject.breakpoints
        .at('../app.js')
        .breakpoint({ text: `console.log('Very simple webpage');` });
      await breakpoint.assertIsHitThenResumeWhen(() => launchProject.page.reload());
    },
  );
});
