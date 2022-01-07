/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { generate } from 'astring';
import * as nls from 'vscode-nls';
import Cdp from '../cdp/api';
import { MultiMap } from '../common/datastructure/multimap';
import { flatten } from '../common/objUtils';
import { parseSource, statementsToFunction } from '../common/sourceCodeManipulations';
import { IRenameProvider } from '../common/sourceMaps/renameProvider';
import Dap from '../dap/api';
import * as errors from '../dap/errors';
import * as objectPreview from './objectPreview';
import { StackFrame, StackTrace } from './stackTrace';
import { getSourceSuffix, RemoteException } from './templates';
import { getArrayProperties } from './templates/getArrayProperties';
import { getArraySlots } from './templates/getArraySlots';
import { invokeGetter } from './templates/invokeGetter';
import { readMemory } from './templates/readMemory';
import { writeMemory } from './templates/writeMemory';

const localize = nls.loadMessageBundle();

const identifierRe = /^[$a-z_][0-9a-z_$]*$/;
const privatePropertyRe = /^#[0-9a-z_$]+$/;

// Types that allow readMemory and writeMemory
const memoryReadableTypes: ReadonlySet<Cdp.Runtime.RemoteObject['subtype']> = new Set([
  'typedarray',
  'dataview',
  'arraybuffer',
  'webassemblymemory',
]);

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

  /**
   * Returns the memory reference, if this data type can be inspeted. It's
   * pinned to the accessor (aka `evaluateName`) since objectIds are not stable
   * between stackframes, or even multiple reads of the same stackframe.
   */
  public get memoryReference() {
    return memoryReadableTypes.has(this.o.subtype) ? this.accessor : undefined;
  }

  constructor(
    public readonly name: string | number,
    cdp: Cdp.Api,
    object: Cdp.Runtime.RemoteObject,
    public readonly variablesReference: number,
    public readonly parent?: RemoteObject,
    public renamedFromSource?: string,
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
    if (identifierRe.test(this.name)) {
      return `${this.parent.accessor}.${this.name}`;
    }

    if (this.parent.accessor === 'this' && privatePropertyRe.test(this.name)) {
      return `${this.parent.accessor}.${this.name}`;
    }

    return `${this.parent.accessor}[${JSON.stringify(this.name)}]`;
  }
}

export interface IScopeRef {
  stackFrame: StackFrame;
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

type AnyPropertyDescriptor = Cdp.Runtime.PropertyDescriptor | Cdp.Runtime.PrivatePropertyDescriptor;

const isCompletePropertyDescriptor = (
  p: AnyPropertyDescriptor,
): p is Cdp.Runtime.PropertyDescriptor => p.hasOwnProperty('configurable');

const addPresentationHint = (v: Dap.Variable, p: Dap.VariablePresentationHint) => {
  if (!v.presentationHint) {
    v.presentationHint = p;
    return;
  }

  const hint = v.presentationHint;
  if (p.visibility) {
    hint.visibility = p.visibility;
  }

  if (p.kind) {
    hint.kind = p.kind;
  }

  if (p.attributes) {
    hint.attributes = hint.attributes
      ? hint.attributes.concat(p.attributes.filter(p => !hint.attributes?.includes(p)))
      : p.attributes;
  }
};

const scorePresentationHint = (v: Dap.Variable) =>
  !v.presentationHint
    ? 0
    : v.presentationHint.visibility === 'private'
    ? 1
    : v.presentationHint.visibility === 'internal'
    ? 2
    : 0;

export class VariableStore {
  private static _lastVariableReference = 1;

  public static nextVariableReference() {
    return VariableStore._lastVariableReference++ & 0x7fffffff;
  }

  private _cdp: Cdp.Api;
  private _referenceToVariables: Map<number, () => Promise<Dap.Variable[]>> = new Map();
  private _remoteObjects = new MultiMap<
    RemoteObject,
    {
      objectId: Cdp.Runtime.RemoteObjectId;
      variableReference: number;
      evaluateName: string;
    }
  >({
    objectId: o => o.objectId,
    variableReference: o => o.variablesReference,
    evaluateName: o => o.accessor,
  });

  private _delegate: IVariableStoreDelegate;

  constructor(
    cdp: Cdp.Api,
    private readonly dap: Dap.Api,
    delegate: IVariableStoreDelegate,
    private readonly renameProvider: IRenameProvider,
    private readonly autoExpandGetters: boolean,
    private readonly customDescriptionGenerator: string | undefined,
    private readonly customPropertiesGenerator: string | undefined,
  ) {
    this._cdp = cdp;
    this._delegate = delegate;
  }

  createDetached() {
    return new VariableStore(
      this._cdp,
      this.dap,
      this._delegate,
      this.renameProvider,
      this.autoExpandGetters,
      this.customDescriptionGenerator,
      this.customPropertiesGenerator,
    );
  }

  hasVariables(variablesReference: number): boolean {
    return (
      this._referenceToVariables.has(variablesReference) ||
      this._remoteObjects.has('variableReference', variablesReference)
    );
  }

  hasMemory(memoryReference: string): boolean {
    return this._remoteObjects.has('evaluateName', memoryReference);
  }

  async getVariables(params: Dap.VariablesParams): Promise<Dap.Variable[]> {
    const result = this._referenceToVariables.get(params.variablesReference);
    if (result) return await result();

    const object = this._remoteObjects.get('variableReference', params.variablesReference);
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

        return [
          await this._createVariable(
            '',
            this.createRemoteObject(object.name, result, object.parent),
            'repl',
          ),
        ];
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
            await this._createVariable(
              extraProperty.name,
              this.createRemoteObject(extraProperty.name, extraProperty.value, object),
              'propertyValue',
            ),
          );
      object.scopeVariables = variables;
    }
    return variables;
  }

  async setVariable(params: Dap.SetVariableParams): Promise<Dap.SetVariableResult | Dap.Error> {
    const object = this._remoteObjects.get('variableReference', params.variablesReference);
    if (!object)
      return errors.createSilentError(localize('error.variableNotFound', 'Variable not found'));

    if (!params.value)
      return errors.createUserError(localize('error.emptyExpression', 'Cannot set an empty value'));

    const expression = params.value + getSourceSuffix();
    const evaluateResponse = object.scopeRef
      ? await object.cdp.Debugger.evaluateOnCallFrame({
          expression: expression,
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
        functionDeclaration: `function(a, b) { this[a] = b; ${getSourceSuffix()} }`,
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
      this.createRemoteObject(params.name, evaluateResponse.result),
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

  async createVariableForWatchEval(
    value: Cdp.Runtime.RemoteObject,
    watchExpr: string,
  ): Promise<Dap.Variable> {
    return this._createVariable('', this.createRemoteObject(`(${watchExpr})`, value), 'watch');
  }

  async createVariable(value: Cdp.Runtime.RemoteObject, context?: string): Promise<Dap.Variable> {
    return this._createVariable('', this.createRemoteObject('', value), context);
  }

  async createScope(
    value: Cdp.Runtime.RemoteObject,
    scopeRef: IScopeRef,
    extraProperties: IExtraProperty[],
  ): Promise<Dap.Variable> {
    const object = this.createRemoteObject('', value);
    object.scopeRef = scopeRef;
    object.extraProperties = extraProperties;
    return this._createVariable('', object);
  }

  /**
   * Returns the variable reference for a complex, object-including output.
   */
  public async createVariableForOutput(
    text: string,
    args: ReadonlyArray<Cdp.Runtime.RemoteObject>,
    stackTrace?: StackTrace,
  ): Promise<number> {
    let rootObjectVariable: Dap.Variable;
    if (args.length === 1 && objectPreview.previewAsObject(args[0]) && !stackTrace) {
      rootObjectVariable = await this._createVariable('', this.createRemoteObject('', args[0]));
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

  public async readMemory(
    memoryReference: string,
    offset: number,
    count: number,
  ): Promise<Buffer | undefined> {
    const variable = this._remoteObjects.get('evaluateName', memoryReference);
    if (!variable) {
      return undefined;
    }

    const result = await readMemory({
      cdp: variable.cdp,
      args: [offset, count],
      objectId: variable.objectId,
      returnByValue: true,
    });

    return Buffer.from(result.value, 'hex');
  }

  public async writeMemory(
    memoryReference: string,
    offset: number,
    memory: Buffer,
  ): Promise<number> {
    const variable = this._remoteObjects.get('evaluateName', memoryReference);
    if (!variable) {
      return 0;
    }

    const result = await writeMemory({
      cdp: variable.cdp,
      args: [offset, memory.toString('hex')],
      objectId: variable.objectId,
      returnByValue: true,
    });

    if (result.value > 0) {
      if (variable.parent) {
        this.clearChildren(variable.parent);
      } else {
        this.clear();
      }
      this.dap.invalidated({ areas: ['variables'] });
    }

    return result.value;
  }

  private async _createVariableForOutputParams(
    args: ReadonlyArray<Cdp.Runtime.RemoteObject>,
    stackTrace?: StackTrace,
  ): Promise<Dap.Variable[]> {
    const params: Dap.Variable[] = [];

    for (let i = 0; i < args.length; ++i) {
      if (!objectPreview.previewAsObject(args[i])) continue;
      params.push(
        await this._createVariable(`arg${i}`, this.createRemoteObject(`arg${i}`, args[i]), 'repl'),
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
    this._remoteObjects.clear();
  }

  private clearChildren(variable: RemoteObject) {
    if (!variable.scopeVariables) {
      return;
    }

    for (const child of variable.scopeVariables) {
      const childVar = this._remoteObjects.get('variableReference', child.variablesReference);
      this._referenceToVariables.delete(child.variablesReference);
      if (childVar) {
        this._remoteObjects.delete(childVar);
        this.clearChildren(childVar);
      }
    }

    variable.scopeVariables = undefined;
  }

  private async _getObjectProperties(
    object: RemoteObject,
    objectId = object.objectId,
  ): Promise<Dap.Variable[]> {
    const properties: (
      | Promise<{ v: Dap.Variable; weight: number }[]>
      | { v: Dap.Variable; weight: number }[]
    )[] = [];

    if (this.customPropertiesGenerator) {
      const { result, errorDescription } = await this.evaluateCodeForObject(
        object,
        [],
        this.customPropertiesGenerator,
        [],
        /*catchAndReturnErrors*/ false,
      );

      if (result && result.type !== 'undefined') {
        object = this.createRemoteObject(object.name, result, object.parent);
        objectId = object.objectId;
      } else {
        const value =
          result?.description || errorDescription || localize('error.unknown', 'Unknown error');
        properties.push([
          {
            v: {
              name: localize(
                'error.failedToCustomizeObjectProperties',
                `Failed properties customization`,
              ),
              value,
              variablesReference: 0,
            },
            weight: 0,
          },
        ]);
      }
    }

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
    const propertiesMap = new Map<string, AnyPropertyDescriptor>();
    const propertySymbols: AnyPropertyDescriptor[] = [];
    for (const property of accessorsProperties.result) {
      if (property.symbol) {
        propertySymbols.push(property);
        continue;
      }

      // Handle updated prototype representation in recent V8 (vscode#130365)
      if (
        property.name === '__proto__' &&
        ownProperties.internalProperties?.some(p => p.name === '[[Prototype]]')
      ) {
        continue;
      }

      propertiesMap.set(property.name, property);
    }
    for (const property of ownProperties.result) {
      if (property.get || property.set) continue;
      if (property.symbol) propertySymbols.push(property);
      else propertiesMap.set(property.name, property);
    }
    for (const property of ownProperties.privateProperties ?? []) {
      propertiesMap.set(property.name, property);
    }

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
      let variable: Dap.Variable | undefined;
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
      } else if (p.value !== undefined) {
        variable = await this._createVariable(
          p.name,
          this.createRemoteObject(p.name, p.value, object),
        );
      }

      if (variable) {
        properties.push([
          { v: { ...variable, presentationHint: { visibility: 'internal' } }, weight },
        ]);
      }
    }

    // Wrap up
    const resolved = flatten(await Promise.all(properties));
    resolved.sort((a, b) => {
      const apres = scorePresentationHint(a.v);
      const bpres = scorePresentationHint(b.v);
      if (apres !== bpres) return apres - bpres;
      const aname = a.v.name.includes(' ') ? a.v.name.split(' ')[0] : a.v.name;
      const bname = b.v.name.includes(' ') ? b.v.name.split(' ')[0] : b.v.name;
      if (!isNaN(+aname) && !isNaN(+bname)) return +aname - +bname;
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

  private async _createVariablesForProperty(
    p: AnyPropertyDescriptor,
    owner: RemoteObject,
  ): Promise<Dap.Variable[]> {
    const result: Dap.Variable[] = [];

    // If the value is simply present, add that
    if ('value' in p && p.value) {
      result.push(
        await this._createVariable(
          p.name,
          this.createRemoteObject(p.name, p.value, owner),
          'propertyValue',
        ),
      );
    }

    // if it's a getter, auto expand as requested
    const hasGetter = p.get && p.get.type !== 'undefined';
    if (hasGetter) {
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
        result.push(
          await this._createVariable(
            p.name,
            this.createRemoteObject(p.name, value, owner),
            'propertyValue',
          ),
        );
      } else {
        const obj = this.createRemoteObject(p.name, p.get as Cdp.Runtime.RemoteObject, owner);
        obj.evaluteOnInspect = true;
        result.push(this._createGetter(`${p.name} (get)`, obj, 'propertyValue'));
      }
    }

    // add setter if present
    const hasSetter = p.set && p.set.type !== 'undefined';
    if (hasSetter) {
      result.push(
        await this._createVariable(
          `${p.name} (set)`,
          this.createRemoteObject(p.name, p.set as Cdp.Runtime.RemoteObject, owner),
          'propertyValue',
        ),
      );
    }

    if (hasGetter && !hasSetter) {
      result.forEach(r => addPresentationHint(r, { attributes: ['readOnly'] }));
    }

    if (isCompletePropertyDescriptor(p)) {
      if (p.enumerable === false) {
        result.forEach(r => addPresentationHint(r, { visibility: 'internal' }));
      }
      if (p.writable === false) {
        result.forEach(r => addPresentationHint(r, { attributes: ['readOnly'] }));
      }
    } else {
      result.forEach(r => addPresentationHint(r, { visibility: 'internal' }));
    }

    return result;
  }

  private async _createVariable(
    name: string,
    value?: RemoteObject,
    context?: string,
  ): Promise<Dap.Variable> {
    const scopeRef = value?.parent?.scopeRef;
    if (scopeRef) {
      const renames = await this.renameProvider.provideOnStackframe(scopeRef.stackFrame);
      const original = renames.getOriginalName(name, scopeRef.stackFrame.rawPosition);
      if (original) {
        name = original;
      }
    }

    if (!value) {
      return {
        name,
        value: '',
        variablesReference: 0,
      };
    }

    if (objectPreview.isArray(value.o)) {
      return await this._createArrayVariable(name, value, context);
    }

    if (value.objectId && !objectPreview.subtypesWithoutPreview.has(value.o.subtype)) {
      return await this._createObjectVariable(name, value, context);
    }

    return this._createPrimitiveVariable(name, value, context);
  }

  private _createGetter(name: string, value: RemoteObject, context: string): Dap.Variable {
    return {
      name,
      value: objectPreview.previewRemoteObject(value.o, context),
      evaluateName: value.accessor,
      type: value.o.type,
      variablesReference: value.variablesReference,
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

  private async _createObjectVariable(
    name: string,
    value: RemoteObject,
    context?: string,
  ): Promise<Dap.Variable> {
    const object = value.o;
    return {
      name,
      value: await this._generateVariableValueDescription(name, value, object, context),
      memoryReference: value.memoryReference,
      evaluateName: value.accessor,
      type: object.subtype || object.type,
      variablesReference: value.variablesReference,
    };
  }

  private async _generateVariableValueDescription(
    name: string,
    value: RemoteObject,
    object: Cdp.Runtime.RemoteObject,
    context?: string,
  ): Promise<string> {
    const defaultValueDescription =
      (name === '__proto__' && object.description) ||
      objectPreview.previewRemoteObject(object, context);

    if (!this.customDescriptionGenerator) {
      return defaultValueDescription;
    }

    const { result, errorDescription } = await this.evaluateCodeForObject(
      object,
      ['defaultValue'],
      this.customDescriptionGenerator,
      [defaultValueDescription],
      /*catchAndReturnErrors*/ true,
    );

    return result?.value
      ? '' + result.value
      : localize(
          'error.customValueDescriptionGeneratorFailed',
          "{0} (couldn't describe: {1})",
          defaultValueDescription,
          errorDescription,
        );
  }

  private async evaluateCodeForObject(
    object: Cdp.Runtime.RemoteObject | RemoteObject,
    parameterNames: string[],
    codeToEvaluate: string,
    argumentsToEvaluateWith: string[],
    catchAndReturnErrors: boolean,
  ): Promise<{ result?: Cdp.Runtime.RemoteObject; errorDescription?: string }> {
    try {
      const customValueDescription = await this._cdp.Runtime.callFunctionOn({
        objectId: object.objectId,
        functionDeclaration: this.extractFunctionFromCustomDescriptionGenerator(
          parameterNames,
          codeToEvaluate,
          catchAndReturnErrors,
        ),
        arguments: argumentsToEvaluateWith.map(arg => this._toCallArgument(arg)),
      });

      if (customValueDescription) {
        if (customValueDescription.exceptionDetails === undefined) {
          return { result: customValueDescription.result };
        } else if (customValueDescription && customValueDescription.result.description) {
          return { errorDescription: customValueDescription.result.description };
        }
      }
      return { errorDescription: localize('error.unknown', 'Unknown error') };
    } catch (e) {
      return { errorDescription: e.stack || e.message || String(e) };
    }
  }

  private extractFunctionFromCustomDescriptionGenerator(
    parameterNames: string[],
    generatorDefinition: string,
    catchAndReturnErrors: boolean,
  ): string {
    const code = statementsToFunction(
      parameterNames,
      parseSource(generatorDefinition),
      catchAndReturnErrors,
    );
    return generate(code);
  }

  private async _createArrayVariable(
    name: string,
    value: RemoteObject,
    context?: string,
  ): Promise<Dap.Variable> {
    const object = value.o;
    const match = String(object.description).match(/\(([0-9]+)\)/);
    const arrayLength = match ? +match[1] : 0;

    // For small arrays (less than 100 items), pretend we don't have indexex properties.
    return {
      name,
      value: await this._generateVariableValueDescription(name, value, object, context),
      type: object.className || object.subtype || object.type,
      variablesReference: value.variablesReference,
      memoryReference: value.memoryReference,
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

  private createRemoteObject(
    name: string | number,
    object: Cdp.Runtime.RemoteObject,
    parent?: RemoteObject,
    renamedFromSource?: string,
  ) {
    const o = new RemoteObject(
      name,
      this._cdp,
      object,
      VariableStore.nextVariableReference(),
      parent,
      renamedFromSource,
    );
    this._remoteObjects.add(o);
    return o;
  }
}

function errorFromException(details: Cdp.Runtime.ExceptionDetails): Dap.Error {
  const message =
    (details.exception && objectPreview.previewException(details.exception).title) || details.text;
  return errors.createUserError(message);
}
