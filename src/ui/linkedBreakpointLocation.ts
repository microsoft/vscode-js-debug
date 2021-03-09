/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

/**
 * Interface that can warn the user if a breakpoint is in a symlinked location
 * without an obvious preservation flag.
 */
export interface ILinkedBreakpointLocation {
  warn(): void;
}

export const ILinkedBreakpointLocation = Symbol('ILinkedBreakpointLocation');
