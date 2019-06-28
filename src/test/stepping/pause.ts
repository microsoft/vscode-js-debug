import * as test from '../test';

async function pausedFromInitialScript(p: test.Params) {
  p.dap.launch({url: 'data:text/html,<script>debugger;</script>'});
  const event = await p.dap.once('stopped');
  p.log(event);
  p.log(await p.dap.stackTrace({threadId: event.threadId}));
  p.log(await p.dap.continue({threadId: event.threadId}));
}

async function pausedFromEval(p: test.Params) {
  await p.dap.launch({url: 'data:text/html,blank'});
  p.cdp.Runtime.evaluate({expression: '\n\ndebugger;\n//# sourceURL=eval.js'});
  const event = await p.dap.once('stopped');
  p.log(event);
  p.log(await p.dap.stackTrace({threadId: event.threadId}));
  p.log(await p.dap.continue({threadId: event.threadId}));
}

export default async function runTests() {
  await test.runTest(pausedFromInitialScript);
  await test.runTest(pausedFromEval);
}
