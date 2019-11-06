// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as assert from 'assert';

import { DebugClient } from 'vscode-debugadapter-testsupport';
import { DebugProtocol } from 'vscode-debugprotocol';

export const THREAD_ID = 1;

export function setBreakpointOnStart(
  dc: DebugClient,
  bps: DebugProtocol.SourceBreakpoint[],
  program: string,
  expLine?: number,
  expCol?: number,
  expVerified?: boolean,
): Promise<void> {
  return dc
    .waitForEvent('initialized')
    .then(event => setBreakpoint(dc, bps, program, expLine, expCol, expVerified))
    .then(() => dc.configurationDoneRequest())
    .then(() => {});
}

export function setBreakpoint(
  dc: DebugClient,
  bps: DebugProtocol.SourceBreakpoint[],
  program: string,
  expLine?: number,
  expCol?: number,
  expVerified?: boolean,
): Promise<void> {
  return dc
    .setBreakpointsRequest({
      breakpoints: bps,
      source: { path: program },
    })
    .then(response => {
      const bp = response.body.breakpoints[0];

      if (typeof expVerified === 'boolean')
        assert.equal(bp.verified, expVerified, 'breakpoint verification mismatch: verified');
      if (typeof expLine === 'number')
        assert.equal(bp.line, expLine, 'breakpoint verification mismatch: line');
      if (typeof expCol === 'number')
        assert.equal(bp.column, expCol, 'breakpoint verification mismatch: column');
    });
}

export interface IExpectedStopLocation {
  path?: string;
  line?: number;
  column?: number;
}

export class ExtendedDebugClient extends DebugClient {
  // TODO@Shennie
  async toggleSkipFileStatus(aPath: string): Promise<DebugProtocol.Response> {
    const results = await Promise.all([
      this.send('toggleSkipFileStatus', { path: aPath }),
      this.waitForEvent('stopped'),
    ]);

    return results[0];
  }

  async loadedSources(args: DebugProtocol.LoadedSourcesArguments): Promise<any> {
    const response = await this.send('loadedSources');
    return response.body;
  }

  continueRequest(): Promise<DebugProtocol.ContinueResponse> {
    return super.continueRequest({ threadId: THREAD_ID });
  }

  nextRequest(): Promise<DebugProtocol.NextResponse> {
    return super.nextRequest({ threadId: THREAD_ID });
  }

  stepOutRequest(): Promise<DebugProtocol.StepOutResponse> {
    return super.stepOutRequest({ threadId: THREAD_ID });
  }

  stepInRequest(): Promise<DebugProtocol.StepInResponse> {
    return super.stepInRequest({ threadId: THREAD_ID });
  }

  stackTraceRequest(): Promise<DebugProtocol.StackTraceResponse> {
    return super.stackTraceRequest({ threadId: THREAD_ID });
  }

  continueAndStop(): Promise<any> {
    return Promise.all([
      super.continueRequest({ threadId: THREAD_ID }),
      this.waitForEvent('stopped'),
    ]);
  }

  nextAndStop(): Promise<any> {
    return Promise.all([super.nextRequest({ threadId: THREAD_ID }), this.waitForEvent('stopped')]);
  }

  stepOutAndStop(): Promise<any> {
    return Promise.all([
      super.stepOutRequest({ threadId: THREAD_ID }),
      this.waitForEvent('stopped'),
    ]);
  }

  stepInAndStop(): Promise<any> {
    return Promise.all([
      super.stepInRequest({ threadId: THREAD_ID }),
      this.waitForEvent('stopped'),
    ]);
  }

  async continueTo(
    reason: string,
    expected: IExpectedStopLocation,
  ): Promise<DebugProtocol.StackTraceResponse> {
    const results = await Promise.all([
      this.continueRequest(),
      this.assertStoppedLocation(reason, expected),
    ]);

    return results[1];
  }

  async nextTo(
    reason: string,
    expected: IExpectedStopLocation,
  ): Promise<DebugProtocol.StackTraceResponse> {
    const results = await Promise.all([
      this.nextRequest(),
      this.assertStoppedLocation(reason, expected),
    ]);

    return results[1] as any;
  }

  async stepOutTo(
    reason: string,
    expected: IExpectedStopLocation,
  ): Promise<DebugProtocol.StackTraceResponse> {
    const results = await Promise.all([
      this.stepOutRequest(),
      this.assertStoppedLocation(reason, expected),
    ]);

    return results[1] as any;
  }

  async stepInTo(
    reason: string,
    expected: IExpectedStopLocation,
  ): Promise<DebugProtocol.StackTraceResponse> {
    const results = await Promise.all([
      this.stepInRequest(),
      this.assertStoppedLocation(reason, expected),
    ]);

    return results[1] as any;
  }

  waitForEvent(eventType: string): Promise<DebugProtocol.Event> {
    return super.waitForEvent(eventType);
  }

  /**
   * This is a copy of DebugClient's hitBreakpoint, except that it doesn't assert 'verified' by default. In the Chrome debugger, a bp may be verified or unverified at launch,
   * depending on whether it's randomly received before or after the 'scriptParsed' event for its script. So we can't always check this prop.
   */
  hitBreakpointUnverified(
    launchArgs: any,
    location: { path: string; line: number; column?: number; verified?: boolean },
    expected?: { path?: string; line?: number; column?: number; verified?: boolean },
  ): Promise<any> {
    return Promise.all([
      this.waitForEvent('initialized')
        .then(event => {
          return this.setBreakpointsRequest({
            lines: [location.line],
            breakpoints: [{ line: location.line, column: location.column }],
            source: { path: location.path },
          });
        })
        .then(response => {
          if (response.body.breakpoints.length > 0) {
            const bp = response.body.breakpoints[0];

            if (typeof location.verified === 'boolean') {
              assert.equal(
                bp.verified,
                location.verified,
                'breakpoint verification mismatch: verified',
              );
            }
            if (bp.source && bp.source.path) {
              this.assertPath(
                bp.source.path,
                location.path,
                'breakpoint verification mismatch: path',
              );
            }
            if (typeof bp.line === 'number') {
              assert.equal(bp.line, location.line, 'breakpoint verification mismatch: line');
            }
            if (typeof location.column === 'number' && typeof bp.column === 'number') {
              assert.equal(bp.column, location.column, 'breakpoint verification mismatch: column');
            }
          }

          return this.configurationDoneRequest();
        }),

      this.launch(launchArgs),

      this.assertStoppedLocation('breakpoint', expected || location),
    ]);
  }
}
