// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as path from 'path';
import * as puppeteer from 'puppeteer';
import * as testSetup from './testSetup';
import { DebugProtocol } from 'vscode-debugprotocol';
import { FrameworkTestContext, TestProjectSpec } from './framework/frameworkTestSupport';
import { BreakpointsWizard } from './wizards/breakpoints/breakpointsWizard';
import { ExpectedFrame } from './wizards/breakpoints/implementation/stackTraceObjectAssertions';
import { puppeteerSuite, puppeteerTest } from './puppeteer/puppeteerSuite';

const DATA_ROOT = testSetup.DATA_ROOT;
const SIMPLE_PROJECT_ROOT = path.join(DATA_ROOT, 'stackTrace');
const TEST_SPEC = new TestProjectSpec({
  projectRoot: SIMPLE_PROJECT_ROOT,
  projectSrc: SIMPLE_PROJECT_ROOT,
});

interface StackTraceValidationConfig {
  suiteContext: FrameworkTestContext;
  page: puppeteer.Page;
  breakPointLabel: string;
  buttonIdToClick: string;
  format?: DebugProtocol.StackFrameFormat;
  expectedFrames: ExpectedFrame[];
}

async function validateStackTrace(config: StackTraceValidationConfig): Promise<void> {
  const incBtn = await config.page.waitForSelector(config.buttonIdToClick);

  const breakpoints = BreakpointsWizard.create(config.suiteContext.debugClient, TEST_SPEC);
  const breakpointWizard = breakpoints.at('app.js');

  const setStateBreakpoint = await breakpointWizard.breakpoint({
    text: "console.log('Test stack trace here')",
  });

  await setStateBreakpoint.assertIsHitThenResumeWhen(() => incBtn.click(), {
    stackTrace: config.expectedFrames,
    stackFrameFormat: config.format,
  });
}

puppeteerSuite('Stack Traces', TEST_SPEC, suiteContext => {
  // Need attach mode
  puppeteerTest(
    'Stack trace is generated with no formatting',
    suiteContext,
    async (_context, page) => {
      await validateStackTrace({
        suiteContext: suiteContext,
        page: page,
        breakPointLabel: 'stackTraceBreakpoint',
        buttonIdToClick: '#button',
        format: {},
        expectedFrames: [
          {
            name: '<anonymous>',
            line: 11,
            column: 9,
            source: { fileRelativePath: 'app.js' },
            presentationHint: 'normal',
          },
          {
            name: 'evalCallback',
            line: 12,
            column: 7,
            source: { fileRelativePath: 'app.js' },
            presentationHint: 'normal',
          },
          {
            name: '<anonymous>',
            line: 1,
            column: 1,
            source: { evalCode: true },
            presentationHint: 'normal',
          },
          {
            name: 'timeoutCallback',
            line: 6,
            column: 5,
            source: { fileRelativePath: 'app.js' },
            presentationHint: 'normal',
          },
          { name: 'setTimeout', presentationHint: 'label' },
          {
            name: 'buttonClick',
            line: 2,
            column: 5,
            source: { fileRelativePath: 'app.js' },
            presentationHint: 'normal',
          },
          {
            name: 'onclick',
            line: 7,
            column: 49,
            source: { url: suiteContext.launchProject!.url },
            presentationHint: 'normal',
          },
        ],
      });
    },
  );

  puppeteerTest(
    'Stack trace is generated with module formatting',
    suiteContext,
    async (_context, page) => {
      const url = suiteContext.launchProject!.url;
      await validateStackTrace({
        suiteContext: suiteContext,
        page: page,
        breakPointLabel: 'stackTraceBreakpoint',
        buttonIdToClick: '#button',
        format: {
          module: true,
        },
        expectedFrames: [
          {
            name: '(anonymous function) [app.js]',
            line: 11,
            column: 9,
            source: { fileRelativePath: 'app.js' },
            presentationHint: 'normal',
          },
          {
            name: 'evalCallback [app.js]',
            line: 12,
            column: 7,
            source: { fileRelativePath: 'app.js' },
            presentationHint: 'normal',
          },
          {
            name: /\(eval code\) \[.*VM.*]/,
            line: 1,
            column: 1,
            source: { evalCode: true },
            presentationHint: 'normal',
          },
          {
            name: 'timeoutCallback [app.js]',
            line: 6,
            column: 5,
            source: { fileRelativePath: 'app.js' },
            presentationHint: 'normal',
          },
          { name: '[ setTimeout ]', presentationHint: 'label' },
          {
            name: 'buttonClick [app.js]',
            line: 2,
            column: 5,
            source: { fileRelativePath: 'app.js' },
            presentationHint: 'normal',
          },
          {
            name: `onclick [${url.host}]`,
            line: 7,
            column: 49,
            source: { url },
            presentationHint: 'normal',
          },
        ],
      });
    },
  );

  puppeteerTest(
    'Stack trace is generated with line formatting',
    suiteContext,
    async (_context, page) => {
      await validateStackTrace({
        suiteContext: suiteContext,
        page: page,
        breakPointLabel: 'stackTraceBreakpoint',
        buttonIdToClick: '#button',
        format: {
          line: true,
        },
        expectedFrames: [
          {
            name: '(anonymous function) Line 11',
            line: 11,
            column: 9,
            source: { fileRelativePath: 'app.js' },
            presentationHint: 'normal',
          },
          {
            name: 'evalCallback Line 12',
            line: 12,
            column: 7,
            source: { fileRelativePath: 'app.js' },
            presentationHint: 'normal',
          },
          {
            name: '(eval code) Line 1',
            line: 1,
            column: 1,
            source: { evalCode: true },
            presentationHint: 'normal',
          },
          {
            name: 'timeoutCallback Line 6',
            line: 6,
            column: 5,
            source: { fileRelativePath: 'app.js' },
            presentationHint: 'normal',
          },
          { name: '[ setTimeout ]', presentationHint: 'label' },
          {
            name: 'buttonClick Line 2',
            line: 2,
            column: 5,
            source: { fileRelativePath: 'app.js' },
            presentationHint: 'normal',
          },
          {
            name: 'onclick Line 7',
            line: 7,
            column: 49,
            source: { url: suiteContext.launchProject!.url },
            presentationHint: 'normal',
          },
        ],
      });
    },
  );

  puppeteerTest(
    'Stack trace is generated with all formatting',
    suiteContext,
    async (_context, page) => {
      const url = suiteContext.launchProject!.url;
      await validateStackTrace({
        suiteContext: suiteContext,
        page: page,
        breakPointLabel: 'stackTraceBreakpoint',
        buttonIdToClick: '#button',
        format: {
          parameters: true,
          parameterTypes: true,
          parameterNames: true,
          line: true,
          module: true,
        },
        expectedFrames: [
          {
            name: '(anonymous function) [app.js] Line 11',
            line: 11,
            column: 9,
            source: { fileRelativePath: 'app.js' },
            presentationHint: 'normal',
          },
          {
            name: 'evalCallback [app.js] Line 12',
            line: 12,
            column: 7,
            source: { fileRelativePath: 'app.js' },
            presentationHint: 'normal',
          },
          {
            name: /\(eval code\) \[.*VM.*] Line 1/,
            line: 1,
            column: 1,
            source: { evalCode: true },
            presentationHint: 'normal',
          },
          {
            name: 'timeoutCallback [app.js] Line 6',
            line: 6,
            column: 5,
            source: { fileRelativePath: 'app.js' },
            presentationHint: 'normal',
          },
          { name: '[ setTimeout ]', presentationHint: 'label' },
          {
            name: 'buttonClick [app.js] Line 2',
            line: 2,
            column: 5,
            source: { fileRelativePath: 'app.js' },
            presentationHint: 'normal',
          },
          {
            name: `onclick [${url.host}] Line 7`,
            line: 7,
            column: 49,
            source: { url },
            presentationHint: 'normal',
          },
        ],
      });
    },
  );
});
