/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import Cdp from '../cdp/api';

type EvaluateParams = {
  expression: string;
  includeCommandLineAPI?: boolean;
  silent?: boolean;
  objectGroup?: string;
  returnByValue?: boolean;
  generatePreview?: boolean;
  userGesture?: boolean;
};

type EvaluateResult = {
  result: Cdp.Runtime.RemoteObject;
  exceptionDetails?: Cdp.Runtime.ExceptionDetails;
};

export type Evaluator = (params: EvaluateParams) => Promise<EvaluateResult | undefined>;

export function fromContextId(cdp: Cdp.Api, contextId?: Cdp.Runtime.ExecutionContextId): Evaluator {
  return (params: EvaluateParams) => cdp.Runtime.evaluate({...params, contextId});
}

export function fromCallFrame(cdp: Cdp.Api, callFrameId: string): Evaluator {
  return (params: EvaluateParams) => cdp.Debugger.evaluateOnCallFrame({...params, callFrameId});
}
