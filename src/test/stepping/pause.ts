import * as test from '../test';

async function pausedFromInitialScript(p: test.Params) {
  p.dap.launch({url: 'data:text/html,<script>debugger;</script>'});
  const event = await p.dap.once('stopped');
  p.log(event);
  p.log(await p.dap.stackTrace({threadId: event.threadId}));
  p.log(await p.dap.continue({threadId: event.threadId}));
}

async function pausedFromEval(p: test.Params) {
  await test.launchAndLoad(p, 'data:text/html,blank');
  p.cdp.Runtime.evaluate({expression: '\n\ndebugger;\n//# sourceURL=eval.js'});
  const event = p.log(await p.dap.once('stopped'));
  p.log(await p.dap.stackTrace({threadId: event.threadId}));
  p.log(await p.dap.continue({threadId: event.threadId}));
}

async function pauseOnExceptions(p: test.Params) {
  async function waitForPauseOnException() {
    const event = p.log(await p.dap.once('stopped'));
    p.log(await p.dap.exceptionInfo({threadId: event.threadId}));
    p.log(await p.dap.continue({threadId: event.threadId}));
  }

  await test.launchAndLoad(p, 'data:text/html,blank');

  p.log('Not pausing on exceptions');
  await p.dap.setExceptionBreakpoints({filters: []});
  await test.evaluate(p, `setTimeout(() => { throw new Error('hello'); })`);
  await test.evaluate(p, `setTimeout(() => { try { throw new Error('hello'); } catch (e) {}})`);

  p.log('Pausing on uncaught exceptions');
  await p.dap.setExceptionBreakpoints({filters: ['uncaught']});
  await test.evaluate(p, `setTimeout(() => { try { throw new Error('hello'); } catch (e) {}})`);
  test.evaluate(p, `setTimeout(() => { throw new Error('hello'); })`);
  await waitForPauseOnException();

  p.log('Pausing on caught exceptions');
  await p.dap.setExceptionBreakpoints({filters: ['caught']});
  test.evaluate(p, `setTimeout(() => { throw new Error('hello'); })`);
  await waitForPauseOnException();
  test.evaluate(p, `setTimeout(() => { try { throw new Error('hello'); } catch (e) {}})`);
  await waitForPauseOnException();
}

async function pauseOnInnerHtml(p: test.Params) {
  await test.launchAndLoad(p, 'data:text/html,<div>text</div>');

  p.log('Not pausing on innerHTML');
  await test.evaluate(p, `document.querySelector('div').innerHTML = 'foo';`);

  p.log('Pausing on innerHTML');
  p.log(await p.dap.updateCustomBreakpoints({breakpoints: [{id: 'instrumentation:Element.setInnerHTML', enabled: true}]}));
  test.evaluate(p, `document.querySelector('div').innerHTML = 'bar';`);
  const event = p.log(await p.dap.once('stopped'));
  p.log(await p.dap.continue({threadId: event.threadId}));
}

export default async function runTests() {
  await test.runTest(pausedFromInitialScript);
  await test.runTest(pausedFromEval);
  await test.runTest(pauseOnExceptions);
  await test.runTest(pauseOnInnerHtml);
}
