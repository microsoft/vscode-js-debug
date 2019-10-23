/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { IFixture } from './fixture';
import { ITestCallbackContext } from 'mocha';
import { PromiseOrNot } from '../testUtils';

/** Run a test doing the setup/cleanup indicated by the provided fixtures */
function testUsingFunction<T extends IFixture>(
  expectation: string,
  fixtureProvider: (context: ITestCallbackContext) => PromiseOrNot<T>,
  testFunction: (fixtures: T) => Promise<void>,
): void {
  suite(expectation, function() {
    let fixture: T | undefined;
    test(expectation, async function() {
      fixture = await fixtureProvider(this);
      await testFunction(fixture);
    });
    teardown(() => {
      if (fixture) {
        return fixture.cleanUp();
      }
    });
  });
}

testUsingFunction.skip = <T extends IFixture>(
  expectation: string,
  _fixtureProvider: (context: ITestCallbackContext) => PromiseOrNot<T>,
  _testFunction: (fixtures: T) => Promise<void>,
) =>
  test.skip(expectation, () => {
    throw new Error(`We don't expect this to be called`);
  });

export const testUsing = testUsingFunction;
