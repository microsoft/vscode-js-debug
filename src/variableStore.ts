// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import Protocol from 'devtools-protocol';
import {DebugProtocol} from 'vscode-debugprotocol';
import ProtocolProxyApi from 'devtools-protocol/types/protocol-proxy-api';
import * as objectPreview from './objectPreview';

class RemoteObject {
  o: Protocol.Runtime.RemoteObject;
  objectId:  Protocol.Runtime.RemoteObjectId;
  cdp: ProtocolProxyApi.ProtocolApi;
  constructor(cdp: ProtocolProxyApi.ProtocolApi, object: Protocol.Runtime.RemoteObject) {
    this.o = object;
    this.objectId = object.objectId;
    this.cdp = cdp;
  }

  wrap(object: Protocol.Runtime.RemoteObject): RemoteObject {
    return new RemoteObject(this.cdp, object);
  }
}

export class VariableStore {
  private static _lastVariableReference: number = 0;
  private _variableToObject: Map<number, RemoteObject> = new Map();
  private _objectToVariable: Map<Protocol.Runtime.RemoteObjectId, number> = new Map();

  async getVariables(params: DebugProtocol.VariablesArguments): Promise<DebugProtocol.Variable[]> {
    const object = this._variableToObject.get(params.variablesReference);
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

  async createVariable(cdp: ProtocolProxyApi.ProtocolApi, value: Protocol.Runtime.RemoteObject, context?: string): Promise<DebugProtocol.Variable> {
    return this._createVariable('', new RemoteObject(cdp, value), context);
  }

  private async _getObjectProperties(object: RemoteObject): Promise<DebugProtocol.Variable[]> {
    const response = await object.cdp.Runtime.getProperties({
      objectId: object.objectId,
      ownProperties: true,
      generatePreview: true
    });
    const properties: Promise<DebugProtocol.Variable>[] = [];
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
      const delta = weight.get(b.name) - weight.get(a.name);
      return delta ? delta : a.name.localeCompare(b.name);
    });
    return result;
  }

  private async _getArrayProperties(params: DebugProtocol.VariablesArguments, object: RemoteObject): Promise<DebugProtocol.Variable[]> {
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
    return this._getObjectProperties(object.wrap(response.result));
  }

  private async _getArraySlots(params: DebugProtocol.VariablesArguments, object: RemoteObject): Promise<DebugProtocol.Variable[]> {
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
    const result = (await this._getObjectProperties(object.wrap(response.result))).filter(p => p.name !== '__proto__');
    return result;
  }

  private _createVariableReference(object: RemoteObject): number {
    const reference = ++VariableStore._lastVariableReference;
    this._variableToObject.set(reference, object);
    this._objectToVariable.set(object.objectId, reference);
    return reference;
  }

  private async _createVariable(name: string, value: RemoteObject, context?: string): Promise<DebugProtocol.Variable> {
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

  private async _createPrimitiveVariable(name: string, value: RemoteObject, context?: string): Promise<DebugProtocol.Variable> {
    return {
      name,
      value: objectPreview.previewRemoteObject(value.o, context),
      type: value.o.type,
      variablesReference: 0
    };
  }

  private async _createObjectVariable(name: string, value: RemoteObject, context?: string): Promise<DebugProtocol.Variable> {
    const variablesReference = this._createVariableReference(value);
    const object = value.o;
    return {
      name,
      value: name === '__proto__' ? objectPreview.briefPreviewRemoteObject(object, context) : objectPreview.previewRemoteObject(object, context),
      type: object.className || object.subtype || object.type,
      variablesReference
    };
  }

  private async _createArrayVariable(name: string, value: RemoteObject, context?: string): Promise<DebugProtocol.Variable> {
    const variablesReference = this._createVariableReference(value);
    const response = await value.cdp.Runtime.callFunctionOn({
      objectId: value.objectId,
      functionDeclaration: `function (prefix) {
          return this.length;
        }`,
      objectGroup: 'console',
      returnByValue: true
    });
    const indexedVariables = response.result.value;

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
