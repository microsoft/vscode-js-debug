/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as objectPreview from './objectPreview';
import Cdp from '../cdp/api';
import Dap from '../dap/api';
import { StackTrace } from './stackTrace';
import * as errors from '../dap/errors';
import * as nls from 'vscode-nls';
import { getArrayProperties } from './templates/getArrayProperties';
import { getArraySlots } from './templates/getArraySlots';
import { invokeGetter } from './templates/invokeGetter';
import { RemoteException } from './templates';
import { flatten } from '../common/objUtils';

const localize = nls.loadMessageBundle();

class RemoteObject {
  /**
   * For functions, returns whether it should be evaluated when inspected.
   * This can be set on side-effect-free objects like accessors who should
   * have their value replaced.
   */
  public evaluteOnInspect = false;

  readonly o: Cdp.Runtime.RemoteObject;
  readonly objectId: Cdp.Runtime.RemoteObjectId;
  readonly cdp: Cdp.Api;

  scopeRef?: IScopeRef;
  extraProperties?: IExtraProperty[];
  // Scope remote object is never updated, even after changing local variables.
  // So, we cache variables here and update locally.
  scopeVariables?: Dap.Variable[];

  constructor(
    public readonly name: string | number,
    cdp: Cdp.Api,
    object: Cdp.Runtime.RemoteObject,
    public readonly parent?: RemoteObject,
  ) {
    this.o = object;
    // eslint-disable-next-line
    this.objectId = object.objectId!;
    this.cdp = cdp;
  }

  /**
   * Gets the accessor though which this object can be read.
   */
  public get accessor(): string {
    if (!this.parent || !this.parent.accessor) {
      return String(this.name);
    }

    if (typeof this.name === 'number' || /^[0-9]+$/.test(this.name)) {
      return `${this.parent.accessor}[${this.name}]`;
    }

    // If the object property looks like a valid identifer, don't use the
    // bracket syntax -- it's ugly!
    if (/^[$a-z_][0-9a-z_$]*$/i.test(this.name)) {
      return `${this.parent.accessor}.${this.name}`;
    }

    return `${this.parent.accessor}[${JSON.stringify(this.name)}]`;
  }

  public wrap(property: string | number, object: Cdp.Runtime.RemoteObject): RemoteObject;
  public wrap(
    property: string | number,
    object?: Cdp.Runtime.RemoteObject,
  ): RemoteObject | undefined;
  public wrap(
    property: string | number,
    object?: Cdp.Runtime.RemoteObject,
  ): RemoteObject | undefined {
    return object ? new RemoteObject(property, this.cdp, object, this) : undefined;
  }
}

export interface IScopeRef {
  callFrameId: Cdp.Debugger.CallFrameId;
  scopeNumber: number;
}

export interface IExtraProperty {
  name: string;
  value: Cdp.Runtime.RemoteObject;
}

export interface IVariableStoreDelegate {
  renderDebuggerLocation(location: Cdp.Debugger.Location): Promise<string>;
}

export class VariableStore {
  private _cdp: Cdp.Api;
  private static _lastVariableReference = 0;
  private _referenceToVariables: Map<number, () => Promise<Dap.Variable[]>> = new Map();
  private _objectToReference: Map<Cdp.Runtime.RemoteObjectId, number> = new Map();
  private _referenceToObject: Map<number, RemoteObject> = new Map();
  private _delegate: IVariableStoreDelegate;

  constructor(
    cdp: Cdp.Api,
    delegate: IVariableStoreDelegate,
    private readonly autoExpandGetters: boolean,
  ) {
    this._cdp = cdp;
    this._delegate = delegate;
  }

  hasVariables(variablesReference: number): boolean {
    return (
      this._referenceToVariables.has(variablesReference) ||
      this._referenceToObject.has(variablesReference)
    );
  }

  async getVariables(params: Dap.VariablesParams): Promise<Dap.Variable[]> {
    const result = this._referenceToVariables.get(params.variablesReference);
    if (result) return await result();

    const object = this._referenceToObject.get(params.variablesReference);
    if (!object) {
      return [];
    }

    if (object.scopeVariables) {
      return object.scopeVariables;
    }

    if (object.evaluteOnInspect && object.parent) {
      try {
        const result = await invokeGetter({
          cdp: object.cdp,
          objectId: object.parent.objectId,
          args: [object.name],
        });

        return [this._createVariable('', object.parent.wrap(object.name, result), 'repl')];
      } catch (e) {
        if (!(e instanceof RemoteException)) {
          throw e;
        }

        // continue
      }
    }

    if (objectPreview.isArray(object.o)) {
      if (params && params.filter === 'indexed') return this._getArraySlots(object, params);
      if (params && params.filter === 'named') return this._getArrayProperties(object);
      const names = await this._getArrayProperties(object);
      const indexes = await this._getArraySlots(object, params);
      return indexes.concat(names);
    }

    const variables = await this._getObjectProperties(object);
    if (object.scopeRef) {
      const existingVariables = new Set(variables.map(v => v.name));
      /* Normally we add the "this" variable as en extra propertie because it's not included in the variables
       * that come from v8. Blazor does include it, and we don't know what other CDP debuggers will do, so we
       * avoid adding duplicated variables.
       */
      for (const extraProperty of object.extraProperties || [])
        if (!existingVariables.has(extraProperty.name))
          variables.push(
            this._createVariable(
              extraProperty.name,
              object.wrap(extraProperty.name, extraProperty.value),
              'propertyValue',
            ),
          );
      object.scopeVariables = variables;
    }
    return variables;
  }

  async setVariable(params: Dap.SetVariableParams): Promise<Dap.SetVariableResult | Dap.Error> {
    const object = this._referenceToObject.get(params.variablesReference);
    if (!object)
      return errors.createSilentError(localize('error.variableNotFound', 'Variable not found'));

    const expression = params.value;
    if (!expression)
      return errors.createUserError(localize('error.emptyExpression', 'Cannot set an empty value'));

    const evaluateResponse = object.scopeRef
      ? await object.cdp.Debugger.evaluateOnCallFrame({
          expression,
          callFrameId: object.scopeRef.callFrameId,
        })
      : await object.cdp.Runtime.evaluate({ expression, silent: true });
    if (!evaluateResponse)
      return errors.createUserError(localize('error.invalidExpression', 'Invalid expression'));
    if (evaluateResponse.exceptionDetails)
      return errorFromException(evaluateResponse.exceptionDetails);

    return this.handleSetVariableEvaluation(params, evaluateResponse, object);
  }

  private async handleSetVariableEvaluation(
    params: Dap.SetVariableParams,
    evaluateResponse: Cdp.Debugger.EvaluateOnCallFrameResult,
    object: RemoteObject,
  ): Promise<Dap.SetVariableResult | Dap.Error> {
    function release(error: Dap.Error): Dap.Error {
      const objectId = evaluateResponse.result.objectId;
      if (objectId) object.cdp.Runtime.releaseObject({ objectId });
      return error;
    }

    if (object.scopeRef) {
      if (object.extraProperties && object.extraProperties.find(p => p.name === params.name))
        return release(
          errors.createSilentError(localize('error.variableNotFound', 'Variable not found')),
        );
      const setResponse = await object.cdp.Debugger.setVariableValue({
        callFrameId: object.scopeRef.callFrameId,
        scopeNumber: object.scopeRef.scopeNumber,
        variableName: params.name,
        newValue: this._toCallArgument(evaluateResponse.result),
      });
      if (!setResponse)
        return release(
          errors.createSilentError(
            localize('error.setVariableDidFail', 'Unable to set variable value'),
          ),
        );
    } else {
      const setResponse = await object.cdp.Runtime.callFunctionOn({
        objectId: object.objectId,
        functionDeclaration: `function(a, b) { this[a] = b; }`,
        arguments: [
          this._toCallArgument(params.name),
          this._toCallArgument(evaluateResponse.result),
        ],
        silent: true,
      });
      if (!setResponse)
        return release(
          errors.createSilentError(
            localize('error.setVariableDidFail', 'Unable to set variable value'),
          ),
        );
      if (setResponse.exceptionDetails)
        return release(errorFromException(setResponse.exceptionDetails));
    }

    const variable = await this._createVariable(
      params.name,
      new RemoteObject(params.name, object.cdp, evaluateResponse.result),
    );
    const result = {
      value: variable.value,
      type: variable.type,
      variablesReference: variable.variablesReference,
      namedVariables: variable.namedVariables,
      indexedVariables: variable.indexedVariables,
    };
    if (object.scopeVariables) {
      const index = object.scopeVariables.findIndex(v => v.name === params.name);
      if (index !== -1) object.scopeVariables[index] = variable;
    }
    return result;
  }

  async createVariable(value: Cdp.Runtime.RemoteObject, context?: string): Promise<Dap.Variable> {
    return this._createVariable('', new RemoteObject('', this._cdp, value), context);
  }

  async createScope(
    value: Cdp.Runtime.RemoteObject,
    scopeRef: IScopeRef,
    extraProperties: IExtraProperty[],
  ): Promise<Dap.Variable> {
    const object = new RemoteObject('', this._cdp, value);
    object.scopeRef = scopeRef;
    object.extraProperties = extraProperties;
    return this._createVariable('', object);
  }

  async createVariableForOutput(
    text: string,
    args: Cdp.Runtime.RemoteObject[],
    stackTrace?: StackTrace,
  ): Promise<number> {
    let rootObjectVariable: Dap.Variable;
    if (args.length === 1 && objectPreview.previewAsObject(args[0]) && !stackTrace) {
      rootObjectVariable = this._createVariable('', new RemoteObject('', this._cdp, args[0]));
      rootObjectVariable.value = text;
    } else {
      const rootObjectReference =
        stackTrace || args.find(a => objectPreview.previewAsObject(a))
          ? ++VariableStore._lastVariableReference
          : 0;
      rootObjectVariable = {
        name: '',
        value: text,
        variablesReference: rootObjectReference,
      };
      this._referenceToVariables.set(rootObjectReference, () =>
        this._createVariableForOutputParams(args, stackTrace),
      );
    }

    const resultReference = ++VariableStore._lastVariableReference;
    this._referenceToVariables.set(resultReference, async () => [rootObjectVariable]);
    return resultReference;
  }

  async _createVariableForOutputParams(
    args: Cdp.Runtime.RemoteObject[],
    stackTrace?: StackTrace,
  ): Promise<Dap.Variable[]> {
    const params: Dap.Variable[] = [];

    for (let i = 0; i < args.length; ++i) {
      if (!objectPreview.previewAsObject(args[i])) continue;
      params.push(
        this._createVariable(`arg${i}`, new RemoteObject(`arg${i}`, this._cdp, args[i]), 'repl'),
      );
    }

    if (stackTrace) {
      const stackTraceVariable: Dap.Variable = {
        name: '',
        value: await stackTrace.format(),
        variablesReference: 0,
      };
      params.push(stackTraceVariable);
    }
    return params;
  }

  async clear() {
    this._referenceToVariables.clear();
    this._objectToReference.clear();
    this._referenceToObject.clear();
  }

  private async _getObjectProperties(
    object: RemoteObject,
    objectId = object.objectId,
  ): Promise<Dap.Variable[]> {
    const [accessorsProperties, ownProperties] = await Promise.all([
      object.cdp.Runtime.getProperties({
        objectId,
        accessorPropertiesOnly: true,
        ownProperties: false,
        generatePreview: true,
      }),
      object.cdp.Runtime.getProperties({
        objectId,
        ownProperties: true,
        generatePreview: true,
      }),
    ]);
    if (!accessorsProperties || !ownProperties) return [];

    // Merge own properties and all accessors.
    const propertiesMap = new Map<string, Cdp.Runtime.PropertyDescriptor>();
    const propertySymbols: Cdp.Runtime.PropertyDescriptor[] = [];
    for (const property of accessorsProperties.result) {
      if (property.symbol) propertySymbols.push(property);
      else propertiesMap.set(property.name, property);
    }
    for (const property of ownProperties.result) {
      if (property.get || property.set) continue;
      if (property.symbol) propertySymbols.push(property);
      else propertiesMap.set(property.name, property);
    }

    const properties: (
      | Promise<{ v: Dap.Variable; weight: number }[]>
      | { v: Dap.Variable; weight: number }[]
    )[] = [];

    // Push own properties & accessors and symbols
    for (const propertiesCollection of [propertiesMap.values(), propertySymbols.values()]) {
      for (const p of propertiesCollection) {
        const weight = objectPreview.propertyWeight(p);
        properties.push(
          this._createVariablesForProperty(p, object).then(p => p.map(v => ({ v, weight }))),
        );
      }
    }

    // Push internal properties
    for (const p of ownProperties.internalProperties || []) {
      if (p.name === '[[StableObjectId]]') {
        continue;
      }

      const weight = objectPreview.internalPropertyWeight(p);
      let variable: Dap.Variable;
      if (
        p.name === '[[FunctionLocation]]' &&
        p.value &&
        (p.value.subtype as string) === 'internal#location'
      ) {
        const loc = p.value.value as Cdp.Debugger.Location;
        variable = {
          name: p.name,
          value: await this._delegate.renderDebuggerLocation(loc),
          variablesReference: 0,
          presentationHint: { visibility: 'internal' },
        };
      } else {
        variable = this._createVariable(p.name, object.wrap(p.name, p.value));
      }

      properties.push([
        { v: { ...variable, presentationHint: { visibility: 'internal' } }, weight },
      ]);
    }

    // Wrap up
    const resolved = flatten(await Promise.all(properties));
    resolved.sort((a, b) => {
      const aname = a.v.name.includes(' ') ? a.v.name.split(' ')[1] : a.v.name;
      const bname = b.v.name.includes(' ') ? b.v.name.split(' ')[1] : b.v.name;
      if (!isNaN(+aname) && !isNaN(+bname)) return +aname - +bname;
      // tslint:disable-next-line
      const delta = b.weight - a.weight;
      return delta ? delta : aname.localeCompare(bname);
    });

    return resolved.map(p => p.v);
  }

  private async _getArrayProperties(object: RemoteObject): Promise<Dap.Variable[]> {
    try {
      const { objectId } = await getArrayProperties({
        cdp: object.cdp,
        args: [],
        objectId: object.objectId,
        generatePreview: true,
      });

      return this._getObjectProperties(object, objectId);
    } catch (e) {
      return [];
    }
  }

  private async _getArraySlots(
    object: RemoteObject,
    params?: Dap.VariablesParams,
  ): Promise<Dap.Variable[]> {
    const start = params && typeof params.start !== 'undefined' ? params.start : -1;
    const count = params && typeof params.count !== 'undefined' ? params.count : -1;
    let objectId: string;
    try {
      const response = await getArraySlots({
        cdp: object.cdp,
        generatePreview: false,
        args: [start, count],
        objectId: object.objectId,
      });

      objectId = response.objectId;
    } catch (e) {
      return [];
    }

    const result = (await this._getObjectProperties(object, objectId)).filter(
      p => p.name !== '__proto__',
    );
    await this._cdp.Runtime.releaseObject({ objectId });
    return result;
  }

  private _createVariableReference(object: RemoteObject): number {
    const reference = ++VariableStore._lastVariableReference;
    this._referenceToObject.set(reference, object);
    this._objectToReference.set(object.objectId, reference);
    return reference;
  }

  private async _createVariablesForProperty(
    p: Cdp.Runtime.PropertyDescriptor,
    owner: RemoteObject,
  ): Promise<Dap.Variable[]> {
    const result: Dap.Variable[] = [];

    // If the value is simply present, add that
    if ('value' in p) {
      result.push(this._createVariable(p.name, owner.wrap(p.name, p.value), 'propertyValue'));
    }

    // if it's a getter, auto expand as requested
    if (p.get && p.get.type !== 'undefined') {
      let value: Cdp.Runtime.RemoteObject | undefined;
      if (this.autoExpandGetters) {
        try {
          value = await invokeGetter({
            cdp: owner.cdp,
            objectId: owner.objectId,
            args: [p.name],
          });
        } catch {
          // fall through
        }
      }

      if (value) {
        result.push(this._createVariable(p.name, owner.wrap(p.name, value), 'propertyValue'));
      } else {
        const obj = owner.wrap(p.name, p.get);
        obj.evaluteOnInspect = true;
        result.push(this._createGetter(`get ${p.name}`, obj, 'propertyValue'));
      }
    }

    // add setter if present
    if (p.set && p.set.type !== 'undefined') {
      result.push(
        this._createVariable(`set ${p.name}`, owner.wrap(p.name, p.set), 'propertyValue'),
      );
    }

    return result;
  }

  private _createVariable(name: string, value?: RemoteObject, context?: string): Dap.Variable {
    if (!value) {
      return {
        name,
        value: '',
        variablesReference: 0,
      };
    }

    if (objectPreview.isArray(value.o)) {
      return this._createArrayVariable(name, value, context);
    }

    if (value.objectId && !objectPreview.subtypesWithoutPreview.has(value.o.subtype)) {
      return this._createObjectVariable(name, value, context);
    }

    return this._createPrimitiveVariable(name, value, context);
  }

  private _createGetter(name: string, value: RemoteObject, context: string): Dap.Variable {
    const reference = this._createVariableReference(value);
    return {
      name,
      value: objectPreview.previewRemoteObject(value.o, context),
      evaluateName: value.accessor,
      type: value.o.type,
      variablesReference: reference,
    };
  }

  private _createPrimitiveVariable(
    name: string,
    value: RemoteObject,
    context?: string,
  ): Dap.Variable {
    return {
      name,
      value: objectPreview.previewRemoteObject(value.o, context),
      evaluateName: value.accessor,
      type: value.o.type,
      variablesReference: 0,
    };
  }

  private _createObjectVariable(name: string, value: RemoteObject, context?: string): Dap.Variable {
    const variablesReference = this._createVariableReference(value);
    const object = value.o;
    return {
      name,
      value:
        (name === '__proto__' && object.description) ||
        objectPreview.previewRemoteObject(object, context),
      evaluateName: value.accessor,
      type: object.subtype || object.type,
      variablesReference,
    };
  }

  private _createArrayVariable(name: string, value: RemoteObject, context?: string): Dap.Variable {
    const object = value.o;
    const variablesReference = this._createVariableReference(value);
    const match = String(object.description).match(/\(([0-9]+)\)/);
    const arrayLength = match ? +match[1] : 0;

    // For small arrays (less than 100 items), pretend we don't have indexex properties.
    return {
      name,
      value:
        (name === '__proto__' && object.description) ||
        objectPreview.previewRemoteObject(object, context),
      type: object.className || object.subtype || object.type,
      variablesReference,
      evaluateName: value.accessor,
      indexedVariables: arrayLength > 100 ? arrayLength : undefined,
      namedVariables: arrayLength > 100 ? 1 : undefined, // do not count properties proactively
    };
  }

  _toCallArgument(value: string | Cdp.Runtime.RemoteObject): Cdp.Runtime.CallArgument {
    if (typeof value === 'string') return { value };
    const object = value as Cdp.Runtime.RemoteObject;
    if (object.objectId) return { objectId: object.objectId };
    if (object.unserializableValue) return { unserializableValue: object.unserializableValue };
    return { value: object.value };
  }
}

function errorFromException(details: Cdp.Runtime.ExceptionDetails): Dap.Error {
  const message =
    (details.exception && objectPreview.previewException(details.exception).title) || details.text;
  return errors.createUserError(message);
}
