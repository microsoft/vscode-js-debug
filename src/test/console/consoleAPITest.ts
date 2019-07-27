// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { TestP } from '../test';

export function addTests(testRunner) {
  // @ts-ignore unused xit/fit variables.
  const { it, fit, xit, describe, fdescribe, xdescribe } = testRunner;

  describe('format', () => {
    it('format string', async ({ p }: { p: TestP }) => {
      await p.launchAndLoad(`blank`);
      await p.logger.evaluateAndLog([
        `console.log('Log')`,
        `console.info('Info')`,
        `console.warn('Warn')`,
        `console.error('Error')`,
        `console.assert(false, 'Assert')`,
        `console.assert(false)`,
        `console.trace('Trace')`,
        `console.count('Counter')`,
        `console.count('Counter')`,
      ]);
      p.assertLog();
    });
  });

  it('format string', async ({ p }: { p: TestP }) => {
    await p.launchAndLoad(`<script>
    var peopleObject = {
      one: ["John", "Smith"],
      two: ["Jane", "Doe"],
      three: ["Emily", "Jones"]
    };
    var peopleObject2 = {
      one: { name: "John", last: "Smith"},
      two: { name: "Jane", last: "Doe"},
      three: { name: "Emily", last: "Jones"}
    };
    var peopleLongHeader = {
      one: { "first name": "John", "last name": "Smith"},
      two: { "first name": "Jane", "last name": "Doe"},
      three: { "first name": "Emily", "last name": "Jones"}
    };
    var peopleArray= [
      ["John", "Smith"],
      ["Jane", "Doe"],
      ["Emily", "Jones"]
    ];
    var trimEmptyColumn = [
      ["John", "Smith", ""],
      ["Jane", "Doe", ""],
      ["Emily", "Jones", ""]
    ];
    var cellOverflow = {
      one: ["John", "Smith"],
      two: ["Jane Jane Jane Jane Jane Jane Jane Jane Jane Jane Jane Jane Jane Jane Jane Jane Jane Jane Jane Jane Jane Jane Jane Jane Jane Jane Jane Jane Jane Jane Jane Jane Jane ",
       "Doe Doe Doe Doe Doe Doe Doe DoeDoe DoeDoe Doe Doe DoeDoe DoeDoe DoeDoe Doe"],
      three: ["Emily", "Jones"]
    };
    var longTableOverflow = [
      new Array(1000).fill(0),
      new Array(1000).fill(1)
    ];
    </script>`);
    await p.logger.evaluateAndLog([
      `console.table(peopleObject)`,
      `console.table(peopleObject2)`,
      `console.table(peopleLongHeader)`,
      `console.table(peopleArray)`,
      `console.table(trimEmptyColumn)`,
      `console.table(cellOverflow)`,
      `console.table(longTableOverflow)`,
    ], { depth: 0 });
    p.assertLog();
  });
}
