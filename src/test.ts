import * as test from './testRunner';
import Dap from './dap/api';
import Cdp from './cdp/api';

async function testInitialize() {
  const {adapter, dap} = await test.setup();
  dap.on('initialized', () => console.log('initialized'));
  console.log(await test.initialize(dap));
  const connection = await adapter.testConnection();
  await test.disconnect(connection, dap);
}

async function testPausedFromInitialScript(cdp: Cdp.Api, dap: Dap.TestApi) {
  dap.launch({url: 'data:text/html,<script>debugger;</script>'});
  const event = await dap.once('stopped');
  console.log(event);
  console.log(await dap.continue({threadId: event.threadId}));
}

async function testPausedFromEval(cdp: Cdp.Api, dap: Dap.TestApi) {
  await dap.launch({url: 'data:text/html,blank'});
  cdp.Runtime.evaluate({expression: 'debugger;'});
  const event = await dap.once('stopped');
  console.log(event);
  console.log(await dap.continue({threadId: event.threadId}));
}

async function runTests() {
  console.log('----- Running testInitialize');
  await testInitialize();
  console.log('----- Done testInitialize');

  await test.runTest(testPausedFromInitialScript);
  await test.runTest(testPausedFromEval);

  console.log('----- All done');
  process.exit(0);
}

runTests();
