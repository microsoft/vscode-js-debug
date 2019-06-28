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
  const event = p.log(await p.dap.once('stopped'));
  p.log(await p.dap.stackTrace({threadId: event.threadId}));
  p.log(await p.dap.continue({threadId: event.threadId}));
}

async function pauseOnExceptions(p: test.Params) {
  let counter = 0;
  async function evaluate(e: string) {
    ++counter;
    p.log(`Evaluating#${counter}: ${e}`);
    return p.cdp.Runtime.evaluate({expression: e + `\n//# sourceURL=eval${counter}.js`});
  }

  async function waitForPauseOnException() {
    const event = p.log(await p.dap.once('stopped'));
    p.log(await p.dap.exceptionInfo({threadId: event.threadId}));
    p.log(await p.dap.continue({threadId: event.threadId}));
  }

  await p.dap.launch({url: 'data:text/html,blank'});

  p.log('Not pausing on exceptions');
  await p.dap.setExceptionBreakpoints({filters: []});
  await evaluate(`setTimeout(() => { throw new Error('hello'); })`);
  await evaluate(`setTimeout(() => { try { throw new Error('hello'); } catch (e) {}})`);

  p.log('Pausing on uncaught exceptions');
  await p.dap.setExceptionBreakpoints({filters: ['uncaught']});
  await evaluate(`setTimeout(() => { try { throw new Error('hello'); } catch (e) {}})`);
  evaluate(`setTimeout(() => { throw new Error('hello'); })`);
  await waitForPauseOnException();

  p.log('Pausing on caught exceptions');
  await p.dap.setExceptionBreakpoints({filters: ['caught']});
  evaluate(`setTimeout(() => { throw new Error('hello'); })`);
  await waitForPauseOnException();
  evaluate(`setTimeout(() => { try { throw new Error('hello'); } catch (e) {}})`);
  await waitForPauseOnException();
}

export default async function runTests() {
  await test.runTest(pausedFromInitialScript);
  await test.runTest(pausedFromEval);
  await test.runTest(pauseOnExceptions);
}
