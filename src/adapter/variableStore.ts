// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as objectPreview from './objectPreview';
import {Cdp, CdpApi} from '../cdp/api';
import Dap from '../dap/api';
import {StackTrace} from './stackTrace';
import {Context} from './context';

class RemoteObject {
  o: Cdp.Runtime.RemoteObject;
  objectId:  Cdp.Runtime.RemoteObjectId;
  cdp: CdpApi;

  constructor(cdp: CdpApi, object: Cdp.Runtime.RemoteObject) {
    this.o = object;
    this.objectId = object.objectId!;
    this.cdp = cdp;
  }

  wrap(object: Cdp.Runtime.RemoteObject): RemoteObject;
  wrap(object?: Cdp.Runtime.RemoteObject): RemoteObject | undefined;
  wrap(object?: Cdp.Runtime.RemoteObject): RemoteObject | undefined {
    return object ? new RemoteObject(this.cdp, object) : undefined;
  }
}

export class VariableStore {
  private static _lastVariableReference: number = 0;
  private _context: Context;
  private _refernceToObject: Map<number, RemoteObject> = new Map();
  private _referenceToVariables: Map<number, Dap.Variable[]> = new Map();
  private _objectToReference: Map<Cdp.Runtime.RemoteObjectId, number> = new Map();

  constructor(context: Context) {
    this._context = context;
  }

  async getVariables(params: Dap.VariablesParams): Promise<Dap.Variable[]> {
    const result = this._referenceToVariables.get(params.variablesReference);
    if (result)
      return result;

    const object = this._refernceToObject.get(params.variablesReference);
    if (!object)
      return [];

    if (object.o.subtype === 'array') {
      if (params.filter === 'indexed')
        return this._getArraySlots(params, object);
      if (params.filter === 'named')
        return this._getArrayProperties(params, object);
      const indexes = await this._getArrayProperties(params, object);
      const names = await this._getArraySlots(params, object);
      return names.concat(indexes);
    }
    return this._getObjectProperties(object);
  }

  async createVariable(cdp: CdpApi, value: Cdp.Runtime.RemoteObject, context?: string): Promise<Dap.Variable> {
    return this._createVariable('', new RemoteObject(cdp, value), context);
  }

  async createVariableForMessageFormat(cdp: CdpApi, text: string, args: Cdp.Runtime.RemoteObject[], stackTrace?: StackTrace): Promise<number> {
    const resultReference = ++VariableStore._lastVariableReference;
    const rootObjectReference = ++VariableStore._lastVariableReference;
    const rootObjectVariable: Dap.Variable = {
      name: '',
      value: text,
      variablesReference: rootObjectReference,
      namedVariables: args.length + (stackTrace ? 1 : 0)
    };
    this._referenceToVariables.set(resultReference, [rootObjectVariable]);

    const params: Promise<Dap.Variable>[] = [];
    for (let i = 0; i < args.length; ++i) {
      if (!args[i].objectId)
        continue;
      params.push(this._createVariable(`arg${i}`, new RemoteObject(cdp, args[i]), 'repl'));
    }

    if (stackTrace) {
      const stackTraceVariable: Dap.Variable = {
        name: '',
        value: await stackTrace.format(),
        variablesReference: 0
      };
      params.push(Promise.resolve(stackTraceVariable));
    }

    this._referenceToVariables.set(rootObjectReference, await Promise.all(params));
    return resultReference;
  }

  private async _getObjectProperties(object: RemoteObject): Promise<Dap.Variable[]> {
    const response = await object.cdp.Runtime.getProperties({
      objectId: object.objectId,
      ownProperties: true,
      generatePreview: true
    });
    if (!response)
      return [];
    const properties: Promise<Dap.Variable>[] = [];
    const weight: Map<string, number> = new Map();
    for (const p of response.result) {
      properties.push(this._createVariable(p.name, object.wrap(p.value)));
      weight.set(p.name, objectPreview.propertyWeight(p));
    }
    for (const p of (response.privateProperties || [])) {
      properties.push(this._createVariable(p.name, object.wrap(p.value)));
      weight.set(p.name, objectPreview.privatePropertyWeight(p));
    }
    for (const p of (response.internalProperties || [])) {
      properties.push(this._createVariable(p.name, object.wrap(p.value)));
      weight.set(p.name, objectPreview.internalPropertyWeight(p));
    }
    const result = await Promise.all(properties);
    result.sort((a, b) => {
      const delta = weight.get(b.name)! - weight.get(a.name)!;
      return delta ? delta : a.name.localeCompare(b.name);
    });
    return result;
  }

  private async _getArrayProperties(params: Dap.VariablesParams, object: RemoteObject): Promise<Dap.Variable[]> {
    const response = await object.cdp.Runtime.callFunctionOn({
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

  private async _getArraySlots(params: Dap.VariablesParams, object: RemoteObject): Promise<Dap.Variable[]> {
    const response = await object.cdp.Runtime.callFunctionOn({
      objectId: object.objectId,
      functionDeclaration: `
        function(start, count) {
          const result = {};
          for (let i = start; i < start + count; ++i) {
            const descriptor = Object.getOwnPropertyDescriptor(this, i);
            if (descriptor)
              Object.defineProperty(result, i, descriptor);
            else
              result[i] = undefined;
          }
          return result;
        }
      `,
      generatePreview: true,
      arguments: [ { value: params.start }, { value: params.count } ]
    });
    if (!response)
      return [];
    const result = (await this._getObjectProperties(object.wrap(response.result))).filter(p => p.name !== '__proto__');
    return result;
  }

  private _createVariableReference(object: RemoteObject): number {
    const reference = ++VariableStore._lastVariableReference;
    this._refernceToObject.set(reference, object);
    this._objectToReference.set(object.objectId, reference);
    return reference;
  }

  private async _createVariable(name: string, value?: RemoteObject, context?: string): Promise<Dap.Variable> {
    if (!value) {
      // TODO(pfeldman): implement getters / setters
      return {
        name,
        value: '',
        variablesReference: 0
      };
    }

    if (value.o.subtype === 'array')
      return this._createArrayVariable(name, value, context);
    if (value.objectId)
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
      value: name === '__proto__' ? objectPreview.briefPreviewRemoteObject(object, context) : objectPreview.previewRemoteObject(object, context),
      type: object.className || object.subtype || object.type,
      variablesReference
    };
  }

  private async _createArrayVariable(name: string, value: RemoteObject, context?: string): Promise<Dap.Variable> {
    const variablesReference = this._createVariableReference(value);
    const response = await value.cdp.Runtime.callFunctionOn({
      objectId: value.objectId,
      functionDeclaration: `function() { return this.length; }`,
      objectGroup: 'console',
      returnByValue: true
    });
    const indexedVariables = response ? response.result.value : 0;

    const object = value.o;
    return {
      name,
      value: objectPreview.previewRemoteObject(object, context),
      type: object.className || object.subtype || object.type,
      variablesReference,
      indexedVariables
    };
  }
}
