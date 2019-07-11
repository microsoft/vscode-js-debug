/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as test from '../test';

async function evaluateBasic(p: test.Params) {
  await test.launchAndLoad(p, 'data:text/html,blank');

  const r1 = p.log(await p.dap.evaluate({expression: `42`}));
  p.log(`No variables: ${r1.variablesReference === 0}`);

  const r2 = p.log(await p.dap.evaluate({expression: `'42'`}));
  p.log(`No variables: ${r2.variablesReference === 0}`);

  const r3 = p.log(await p.dap.evaluate({expression: `({foo: 42})`}));
  p.log(await p.dap.variables({variablesReference: r3.variablesReference}), 'Variables: ');
}

async function setVariable(p: test.Params) {
  await test.launchAndLoad(p, 'data:text/html,blank');

  const r1 = p.log(await p.dap.evaluate({expression: `window.x = ({foo: 42}); x`}), 'evaluate: ');
  p.log(await p.dap.variables({variablesReference: r1.variablesReference}), 'variables before: ');
  const r2 = p.log(await p.dap.setVariable({variablesReference: r1.variablesReference, name: 'foo', value: '{bar: 17}'}), 'setVariable: ');
  p.log(await p.dap.variables({variablesReference: r1.variablesReference}), 'variables after: ');
  p.log(await p.dap.variables({variablesReference: r2.variablesReference}), 'bar variables: ');
  p.log(await p.dap.setVariable({variablesReference: r1.variablesReference, name: 'foo', value: 'baz'}), 'setVariable failure: ');
}

const tests = [
  evaluateBasic,
  setVariable,
];
export default {tests};
