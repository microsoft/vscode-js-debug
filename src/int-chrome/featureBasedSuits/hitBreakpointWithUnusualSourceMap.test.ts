// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as _ from 'lodash';
import { testUsing } from '../fixtures/testUsing';
import { LaunchProject } from '../fixtures/launchProject';
import { TestProjectSpec } from '../framework/frameworkTestSupport';
import { readFileP, writeFileP } from '../testUtils';

suite('Unusual source-maps', () => {
  testUsing(
    `file:/// url in sources' field`,
    async context => {
      const testSpec = TestProjectSpec.fromTestPath(
        'featuresTests/unusualSourceMaps/fileUrlInSources',
      );

      // Update source-map to have a file:/// url in the sources field
      const sourceMapPath = testSpec.src('../app.js.map');
      const sourceMapContents = await readFileP(sourceMapPath);
      const sourceMapJSON = JSON.parse(sourceMapContents.toString());
      sourceMapJSON['sources'] = [`file:///${testSpec.src('../app.ts').replace(/\\/g, '/')}`];
      await writeFileP(sourceMapPath, JSON.stringify(sourceMapJSON));

      return LaunchProject.launch(context, testSpec);
    },
    async launchProject => {
      const executeActionButton = await launchProject.page.waitForSelector('#executeAction');

      const buttonClickedBreakpoint = await launchProject.breakpoints
        .at('../app.ts')
        .breakpoint({ text: `console.log('You clicked the button');` });

      await buttonClickedBreakpoint.assertIsHitThenResumeWhen(() => executeActionButton.click());
    },
  );
});
