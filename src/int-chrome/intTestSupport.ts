// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/*
 * This file contains support functions to make integration testing easier
 */

import { DebugClient } from 'vscode-debugadapter-testsupport';
import { PromiseOrNot } from './testUtils';
import { IChromeLaunchConfiguration, IChromeAttachConfiguration } from '../configuration';

const ImplementsBreakpointLocation = Symbol();
/**
 * Simple breakpoint location params (based on what the debug test client accepts)
 */
export class BreakpointLocation {
  [ImplementsBreakpointLocation]: 'BreakpointLocation';

  public constructor(
    /** The path to the source file in which to set a breakpoint */
    public readonly path: string,
    /** The line number in the file to set a breakpoint on */
    public readonly line: number,
    /** Optional breakpoint column */
    public readonly column?: number,
    /** Whether or not we should assert if the bp is verified or not */
    public readonly verified?: boolean,
  ) {}

  public toString(): string {
    return `${this.path}:${this.line}:${this.column} verified: ${this.verified}`;
  }
}

export type IScenarioConfiguration =
  | IChromeLaunchConfiguration & { scenario: 'launch' }
  | IChromeAttachConfiguration & { scenario: 'attach' };

export interface IDebugAdapterCallbacks {
  registerListeners?: (client: DebugClient) => PromiseOrNot<unknown>;
  configureDebuggee?: (client: DebugClient) => PromiseOrNot<unknown>;
}

/**
 * Launch an instance of chrome and wait for the debug adapter to initialize and attach
 * @param client Debug Client
 * @param launchConfig The launch config to use
 */
export async function launchTestAdapter(
  client: DebugClient,
  launchConfig: IScenarioConfiguration,
  callbacks: IDebugAdapterCallbacks,
) {
  let init = client.waitForEvent('initialized');

  if (callbacks.registerListeners !== undefined) {
    await callbacks.registerListeners(client);
  }

  if (launchConfig.scenario === 'attach') {
    delete launchConfig.url; // We don't want the url property when we attach

    await client.initializeRequest();
    await client.attachRequest(launchConfig);
  } else {
    await client.launch(launchConfig);
  }

  await init;
  if (callbacks.configureDebuggee !== undefined) {
    await callbacks.configureDebuggee(client);
  }
  await client.configurationDoneRequest();
}

/**
 * Easier way to set breakpoints for testing
 * @param client DebugClient
 * @param location Breakpoint location
 */
export function setBreakpoint(
  client: DebugClient,
  location: { path: string; line: number; column?: number; verified?: boolean },
) {
  return client.setBreakpointsRequest({
    lines: [location.line],
    breakpoints: [{ line: location.line, column: location.column }],
    source: { path: location.path },
  });
}

/**
 * Set a conditional breakpoint in a file
 * @param client DebugClient
 * @param location Desired breakpoint location
 * @param condition The condition on which the breakpoint should be hit
 */
export function setConditionalBreakpoint(
  client: DebugClient,
  location: { path: string; line: number; column?: number; verified?: boolean },
  condition: string,
) {
  return client.setBreakpointsRequest({
    lines: [location.line],
    breakpoints: [{ line: location.line, column: location.column, condition }],
    source: { path: location.path },
  });
}
