// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import Cdp from "../cdp/api";
import { Thread } from "./threads";
import { VariableStore } from "./variables";
import Dap from "../dap/api";

export type EvaluationParams = {
  expression: string;
  includeCommandLineAPI?: boolean;
  objectGroup?: string;
  generatePreview?: boolean;
  throwOnSideEffect?: boolean;
  timeout?: number;
  awaitPromise?: boolean;
  silent?: boolean;
};

export interface EvaluationContext {
  evaluate(params: EvaluationParams): Promise<Cdp.Runtime.EvaluateResult | undefined>;
  setVariableValue(object: Cdp.Runtime.RemoteObject, name: string, value: Cdp.Runtime.RemoteObject): Promise<Cdp.Runtime.ExceptionDetails | undefined>;
  completions(): Promise<Dap.CompletionItem[]>;
  thread(): Thread;
  cdp(): Cdp.Api;
  variableStore(): VariableStore;
};

export function toCallArgument(value: string | Cdp.Runtime.RemoteObject): Cdp.Runtime.CallArgument {
  if (typeof value === 'string')
    return { value };
  const object = value as Cdp.Runtime.RemoteObject;
  if (object.objectId)
    return { objectId: object.objectId };
  if (object.unserializableValue)
    return { unserializableValue: object.unserializableValue };
  return { value: object.value };
}

export class ExecutionContext implements EvaluationContext {
  private _thread: Thread;
  private _description: Cdp.Runtime.ExecutionContextDescription;

  constructor(thread: Thread, description: Cdp.Runtime.ExecutionContextDescription) {
    this._thread = thread;
    this._description = description;
  }

  evaluate(params: EvaluationParams): Promise<Cdp.Runtime.EvaluateResult | undefined> {
    return this._thread.cdp().Runtime.evaluate({...params, contextId: this._description.id});
  }

  thread(): Thread {
    return this._thread;
  }

  cdp(): Cdp.Api {
    return this._thread.cdp();
  }

  variableStore(): VariableStore {
    return this._thread.replVariables;
  }

  completions(): Promise<Dap.CompletionItem[]> {
    return Promise.resolve([]);
  }

  description(): Cdp.Runtime.ExecutionContextDescription {
    return this._description;
  }

  name(): string {
    return this._description.name || `context #${this._description.id}`;
  }

  async setVariableValue(object: Cdp.Runtime.RemoteObject, name: string, value: Cdp.Runtime.RemoteObject): Promise<Cdp.Runtime.ExceptionDetails | undefined> {
    if (!object.objectId)
      return;
    const response = await this._thread.cdp().Runtime.callFunctionOn({
      objectId: object.objectId,
      functionDeclaration: `function(a, b) { this[a] = b; }`,
      arguments: [toCallArgument(name), toCallArgument(value)],
      silent: true
    });
    if (response && response.exceptionDetails)
      return response.exceptionDetails;
  }
}
