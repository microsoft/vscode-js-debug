/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
// import * as l10n from '@vscode/l10n';

export type XHRBreakpointId = string;

export interface IXHRBreakpoint {
  match: string;
  // apply: (cdp: Cdp.Api, enabled: boolean) => Promise<boolean>;
}
