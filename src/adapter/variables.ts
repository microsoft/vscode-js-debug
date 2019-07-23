// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as objectPreview from './objectPreview';
import Cdp from '../cdp/api';
import Dap from '../dap/api';
import { StackTrace } from './stackTrace';
import * as errors from './errors';
import * as nls from 'vscode-nls';
import { EvaluationContext } from './evaluation';

const localize = nls.loadMessageBundle();

class RemoteObject {
  o: Cdp.Runtime.RemoteObject;
  objectId: Cdp.Runtime.RemoteObjectId;
  context: EvaluationContext;
  keepProperties?: boolean;

  constructor(context: EvaluationContext, object: Cdp.Runtime.RemoteObject) {
    this.o = object;
    this.objectId = object.objectId!;
    this.context = context;
  }

  wrap(object: Cdp.Runtime.RemoteObject): RemoteObject;
  wrap(object?: Cdp.Runtime.RemoteObject): RemoteObject | undefined;
  wrap(object?: Cdp.Runtime.RemoteObject): RemoteObject | undefined {
    return object ? new RemoteObject(this.context, object) : undefined;
  }
}

export interface VariableStoreDelegate {
  renderDebuggerLocation(location: Cdp.Debugger.Location): Promise<string>;
}

export class VariableStore {
  private static _lastVariableReference: number = 0;
  private _referenceToVariables: Map<number, Dap.Variable[]> = new Map();
  private _objectToReference: Map<Cdp.Runtime.RemoteObjectId, number> = new Map();
  private _referenceToObject: Map<number, RemoteObject> = new Map();
  private _delegate: VariableStoreDelegate;

  constructor(delegate: VariableStoreDelegate) {
    this._delegate = delegate;
  }

  hasVariables(variablesReference: number): boolean {
    return this._referenceToVariables.has(variablesReference) ||
      this._referenceToObject.has(variablesReference);
  }

  async getVariables(params: Dap.VariablesParams): Promise<Dap.Variable[]> {
    const result = this._referenceToVariables.get(params.variablesReference);
    if (result)
      return result;

    const object = this._referenceToObject.get(params.variablesReference);
    const variables = object ? await this._getObjectVariables(object, params) : [];
    if (object && object.keepProperties)
      this._referenceToVariables.set(params.variablesReference, variables);
    return variables;
  }

  async _getObjectVariables(object: RemoteObject, params?: Dap.VariablesParams): Promise<Dap.Variable[]> {
    if (objectPreview.isArray(object.o)) {
      if (params && params.filter === 'indexed')
        return this._getArraySlots(object, params);
      if (params && params.filter === 'named')
        return this._getArrayProperties(object);
      const names = await this._getArrayProperties(object);
      const indexes = await this._getArraySlots(object, params);
      return names.concat(indexes);
    }
    return this._getObjectProperties(object);
  }

  async setVariable(params: Dap.SetVariableParams): Promise<Dap.SetVariableResult | Dap.Error> {
    const object = this._referenceToObject.get(params.variablesReference);
    if (!object)
      return errors.createSilentError(localize('error.variableNotFound', 'Variable not found'));

    const expression = params.value;
    if (!expression)
      return errors.createUserError(localize('error.emptyExpression', 'Cannot set an empty value'));

    const evaluateResponse = await object.context.evaluate({ expression, silent: true, generatePreview: true });
    if (!evaluateResponse)
      return errors.createUserError(localize('error.invalidExpression', 'Invalid expression'));
    if (evaluateResponse.exceptionDetails)
      return errorFromException(evaluateResponse.exceptionDetails);

    function release(error: Dap.Error): Dap.Error {
      const objectId = evaluateResponse!.result.objectId;
      if (objectId)
        object!.context.thread().cdp().Runtime.releaseObject({ objectId });
      return error;
    }

    const setResponse = await object.context.setVariableValue(object.o, params.name, evaluateResponse.result);
    if (setResponse)
      return release(errorFromException(setResponse));

    const variable = await this._createVariable(params.name, new RemoteObject(object.context, evaluateResponse.result));
    const result = {
      value: variable.value,
      type: variable.type,
      variablesReference: variable.variablesReference,
      namedVariables: variable.namedVariables,
      indexedVariables: variable.indexedVariables,
    };

    const variables = this._referenceToVariables.get(params.variablesReference);
    if (variables) {
      const index = variables.findIndex(v => v.name === params.name);
      if (index !== -1)
        variables[index] = variable;
    }
    return result;
  }

  async createVariable(evaluationContext: EvaluationContext, value: Cdp.Runtime.RemoteObject, context?: string, keepProperties?: boolean): Promise<Dap.Variable> {
    const object = new RemoteObject(evaluationContext, value);
    if (keepProperties)
      object.keepProperties = true;
    return this._createVariable('', object, context);
  }

  async createVariableForOutput(evaluationContext: EvaluationContext, text: string, args: Cdp.Runtime.RemoteObject[], stackTrace?: StackTrace): Promise<number> {
    const rootObjectReference = ++VariableStore._lastVariableReference;
    const rootObjectVariable: Dap.Variable = {
      name: '',
      value: text,
      variablesReference: rootObjectReference
    };

    const params: Dap.Variable[] = [];
    const firstArg = args[0];
    if (args.length === 1 && firstArg.objectId && !objectPreview.primitiveSubtypes.has(firstArg.subtype)) {
      // Inline properties for single object parameters.
      const object = new RemoteObject(evaluationContext, args[0]);
      params.push(... await this._getObjectVariables(object));
    } else {
      const promiseParams: Promise<Dap.Variable>[] = [];
      for (let i = 0; i < args.length; ++i) {
        if (!args[i].objectId || objectPreview.primitiveSubtypes.has(args[i].subtype))
          continue;
        promiseParams.push(this._createVariable(`arg${i}`, new RemoteObject(evaluationContext, args[i]), 'repl'));
      }
      params.push(...await Promise.all(promiseParams));
    }

    if (stackTrace) {
      const stackTraceVariable: Dap.Variable = {
        name: '',
        value: await stackTrace.format(),
        variablesReference: 0
      };
      params.push(stackTraceVariable);
    }

    if (!params.length)
      rootObjectVariable.variablesReference = 0;
    rootObjectVariable.namedVariables = params.length;
    this._referenceToVariables.set(rootObjectReference, await Promise.all(params));

    const resultReference = ++VariableStore._lastVariableReference;
    this._referenceToVariables.set(resultReference, [rootObjectVariable]);
    return resultReference;
  }

  async clear(cdp: Cdp.Api) {
    this._referenceToVariables.clear();
    this._objectToReference.clear();
    this._referenceToObject.clear();
    cdp.Runtime.releaseObjectGroup({ objectGroup: 'console' });
  }

  private async _getObjectProperties(object: RemoteObject): Promise<Dap.Variable[]> {
    const [ accessorsProperties, ownProperties] = await Promise.all([
      object.context.thread().cdp().Runtime.getProperties({
        objectId: object.objectId,
        accessorPropertiesOnly: true,
        ownProperties: false,
        generatePreview: true
      }),
      object.context.thread().cdp().Runtime.getProperties({
        objectId: object.objectId,
        ownProperties: true,
        generatePreview: true
      })
    ]);
    if (!accessorsProperties || !ownProperties)
      return [];

    // Merge own properties and all accessors.
    const propertiesMap = new Map<string, Cdp.Runtime.PropertyDescriptor>();
    const propertySymbols: Cdp.Runtime.PropertyDescriptor[] = [];
    for (const property of accessorsProperties.result) {
      if (property.symbol)
        propertySymbols.push(property);
      else
        propertiesMap.set(property.name, property);
    }
    for (const property of ownProperties.result) {
      if (property.get || property.set)
        continue;
      if (property.symbol)
        propertySymbols.push(property);
      else
        propertiesMap.set(property.name, property);
    }

    const propertyPromises: Promise<Dap.Variable>[] = [];
    const weight: Map<string, number> = new Map();

    // Push own properties & accessors
    for (const p of propertiesMap.values()) {
      propertyPromises.push(...this._createVariablesForProperty(p, object));
      weight.set(p.name, objectPreview.propertyWeight(p));
    }

    // Push symbols
    for (const p of propertySymbols.values()) {
      propertyPromises.push(...this._createVariablesForProperty(p, object));
      weight.set(p.name, objectPreview.propertyWeight(p));
    }

    // Push private properties
    for (const p of ownProperties.privateProperties || []) {
      propertyPromises.push(this._createVariable(p.name, object.wrap(p.value)));
      weight.set(p.name, objectPreview.privatePropertyWeight(p));
    }

    // Push internal properties
    for (const p of (ownProperties.internalProperties || [])) {
      if (p.name === '[[StableObjectId]]')
        continue;
      weight.set(p.name, objectPreview.internalPropertyWeight(p));
      if (p.name === '[[FunctionLocation]]' && p.value && p.value.subtype as string === 'internal#location') {
        const loc = p.value.value as Cdp.Debugger.Location;
        propertyPromises.push(Promise.resolve({
          name: p.name,
          value: await this._delegate.renderDebuggerLocation(loc),
          variablesReference: 0
        }));
        continue;
      }
      propertyPromises.push(this._createVariable(p.name, object.wrap(p.value)));
    }

    // Wrap up
    const result = await Promise.all(propertyPromises);
    result.sort((a, b) => {
      const aname = a.name.includes(' ') ? a.name.split(' ')[1] : a.name;
      const bname = b.name.includes(' ') ? b.name.split(' ')[1] : b.name;
      if (!isNaN(+aname) && !isNaN(+bname))
        return +aname - +bname;
      const delta = weight.get(bname)! - weight.get(aname)!;
      return delta ? delta : aname.localeCompare(bname);
    });
    return result;
  }

  private async _getArrayProperties(object: RemoteObject): Promise<Dap.Variable[]> {
    const response = await object.context.thread().cdp().Runtime.callFunctionOn({
      objectId: object.objectId,
      functionDeclaration: `
        function() {
          const result = {__proto__: this.__proto__};
          const names = Object.getOwnPropertyNames(this);
          for (let i = 0; i < names.length; ++i) {
            const name = names[i];
            // Array index check according to the ES5-15.4.
            if (String(name >>> 0) === name && name >>> 0 !== 0xffffffff)
              continue;
            const descriptor = Object.getOwnPropertyDescriptor(this, name);
            if (descriptor)
              Object.defineProperty(result, name, descriptor);
          }
          return result;
        }`,
      generatePreview: true
    });
    if (!response)
      return [];
    return this._getObjectProperties(object.wrap(response.result));
  }

  private async _getArraySlots(object: RemoteObject, params?: Dap.VariablesParams): Promise<Dap.Variable[]> {
    const response = await object.context.thread().cdp().Runtime.callFunctionOn({
      objectId: object.objectId,
      functionDeclaration: `
        function(start, count) {
          const result = {};
          const from = start === -1 ? 0 : start;
          const to = count === -1 ? this.length : start + count;
          for (let i = from; i < to; ++i) {
            const descriptor = Object.getOwnPropertyDescriptor(this, i);
            if (descriptor)
              Object.defineProperty(result, i, descriptor);
          }
          return result;
        }
      `,
      generatePreview: true,
      arguments: [{ value: params ? params.start : -1 }, { value: params ? params.count : -1 }]
    });
    if (!response)
      return [];
    const result = (await this._getObjectProperties(object.wrap(response.result))).filter(p => p.name !== '__proto__');
    return result;
  }

  private _createVariableReference(object: RemoteObject): number {
    const reference = ++VariableStore._lastVariableReference;
    this._referenceToObject.set(reference, object);
    this._objectToReference.set(object.objectId, reference);
    return reference;
  }

  private _createVariablesForProperty(p: Cdp.Runtime.PropertyDescriptor, owner: RemoteObject): Promise<Dap.Variable>[] {
    const result: Promise<Dap.Variable>[] = [];
    if ('value' in p)
      result.push(this._createVariable(p.name, owner.wrap(p.value), 'propertyValue'));
    if (p.get && p.get.type !== 'undefined')
      result.push(this._createVariable(`get ${p.name}`, owner.wrap(p.get), 'propertyValue'));
    if (p.set && p.set.type !== 'undefined')
      result.push(this._createVariable(`set ${p.name}`, owner.wrap(p.set), 'propertyValue'));
    return result;
  }

  private async _createVariable(name: string, value?: RemoteObject, context?: string): Promise<Dap.Variable> {
    if (!value) {
      return {
        name,
        value: '',
        variablesReference: 0
      };
    }

    if (objectPreview.isArray(value.o))
      return this._createArrayVariable(name, value, context);
    if (value.objectId && !objectPreview.primitiveSubtypes.has(value.o.subtype))
      return this._createObjectVariable(name, value, context);
    return this._createPrimitiveVariable(name, value, context);
  }

  private async _createPrimitiveVariable(name: string, value: RemoteObject, context?: string): Promise<Dap.Variable> {
    return {
      name,
      value: objectPreview.previewRemoteObject(value.o, context),
      type: value.o.type,
      variablesReference: 0
    };
  }

  private async _createObjectVariable(name: string, value: RemoteObject, context?: string): Promise<Dap.Variable> {
    const variablesReference = this._createVariableReference(value);
    const object = value.o;
    return {
      name,
      value: name === '__proto__' ? object.description! : objectPreview.previewRemoteObject(object, context),
      type: object.className || object.subtype || object.type,
      variablesReference
    };
  }

  private async _createArrayVariable(name: string, value: RemoteObject, context?: string): Promise<Dap.Variable> {
    const variablesReference = this._createVariableReference(value);
    const response = await value.context.thread().cdp().Runtime.callFunctionOn({
      objectId: value.objectId,
      functionDeclaration: `function() { return this.length; }`,
      objectGroup: 'console',
      returnByValue: true
    });
    const indexedVariables = response ? response.result.value : 0;

    const object = value.o;
    return {
      name,
      value: name === '__proto__' ? object.description! : objectPreview.previewRemoteObject(object, context),
      type: object.className || object.subtype || object.type,
      variablesReference,
      indexedVariables,
      namedVariables: 1  // do not count properties proactively
    };
  }
}

function errorFromException(details: Cdp.Runtime.ExceptionDetails): Dap.Error {
  const message = (details.exception && objectPreview.previewException(details.exception).title) || details.text;
  return errors.createUserError(message);
}
