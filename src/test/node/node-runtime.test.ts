import { itIntegrates } from '../testIntegrationUtils';
import { TestRoot, createFileTree, testFixturesDir, ITestHandle } from '../test';

describe('node runtime', () => {
  async function waitForPause(p: ITestHandle) {
    const { threadId } = p.log(await p.dap.once('stopped'));
    await p.logger.logStackTrace(threadId);
    return p.dap.continue({ threadId });
  }

  itIntegrates('simple script', async ({ r }: { r: TestRoot }) => {
    createFileTree(testFixturesDir, { 'test.ts': 'require("fs").writeFileSync("/Users/copeet/Github/vscode-pwa/greet.txt", "hi"); console.log("hello world"); debugger;'});
    const handle = await r.runScript('test.ts');
    handle.load();
    await waitForPause(handle);
    handle.assertLog();
  });
});
