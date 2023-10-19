/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
// import * as l10n from '@vscode/l10n';
import Cdp from '../cdp/api';

export type XHRBreakpointId = string;

export interface IXHRBreakpoint {
  match: string;
  apply: (cdp: Cdp.Api, enabled: boolean) => Promise<boolean>;
}

export function createXHRBreakpoint(match: string): IXHRBreakpoint {
  return {
    match,
    apply: async (cdp, enabled) => {
      if (enabled)
        return !!(await cdp.DOMDebugger.setXHRBreakpoint({
          url: match,
        }));
      else
        return !!(await cdp.DOMDebugger.removeXHRBreakpoint({
          url: match,
        }));
    },
  };
}

export default createXHRBreakpoint;
