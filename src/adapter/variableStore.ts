/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import { generate } from 'astring';
import { inject, injectable } from 'inversify';
import Cdp from '../cdp/api';
import { ICdpApi } from '../cdp/connection';
import { flatten, isInstanceOf, once } from '../common/objUtils';
import { parseSource, statementsToFunction } from '../common/sourceCodeManipulations';
import { IRenameProvider } from '../common/sourceMaps/renameProvider';
import { AnyLaunchConfiguration } from '../configuration';
import Dap from '../dap/api';
import { IDapApi } from '../dap/connection';
import * as errors from '../dap/errors';
import { ProtocolError } from '../dap/protocolError';
import { ClientCapabilities, IClientCapabilies } from './clientCapabilities';
import { IWasmVariable, IWasmVariableEvaluation, WasmScope } from './dwarf/wasmSymbolProvider';
import { AnsiStyles } from './messageFormat';
import * as objectPreview from './objectPreview';
import { MapPreview, SetPreview } from './objectPreview/betterTypes';
import { PreviewContextType } from './objectPreview/contexts';
import { StackFrame, StackTrace } from './stackTrace';
import { getSourceSuffix, RemoteException, RemoteObjectId } from './templates';
import { getArrayProperties } from './templates/getArrayProperties';
import { getArraySlots } from './templates/getArraySlots';
import { getNodeChildren } from './templates/getNodeChildren';
import {
  getDescriptionSymbols,
  getStringyProps,
  getToStringIfCustom,
} from './templates/getStringyProps';
import { invokeGetter } from './templates/invokeGetter';
import { readMemory } from './templates/readMemory';
import { writeMemory } from './templates/writeMemory';

const getVariableId = (() => {
  let last = 0;
  const max = 0x7fffffff - 1;
  return () => (last++ % max) + 1;
})();

const toCallArgument = (value: string | Cdp.Runtime.RemoteObject) => {
  if (typeof value === 'string') {
    return { value };
  }

  const object = value as Cdp.Runtime.RemoteObject;
  if (object.objectId) {
    return { objectId: object.objectId };
  }

  if (object.unserializableValue) {
    return { unserializableValue: object.unserializableValue };
  }

  return { value: object.value };
};

// Types that allow readMemory and writeMemory
const memoryReadableTypes: ReadonlySet<Cdp.Runtime.RemoteObject['subtype']> = new Set([
  'typedarray',
  'dataview',
  'arraybuffer',
  'webassemblymemory',
]);

export interface IVariableStoreLocationProvider {
  renderDebuggerLocation(location: Cdp.Debugger.Location): Promise<string>;
}

export interface IScopeRef {
  stackFrame: StackFrame;
  callFrameId: Cdp.Debugger.CallFrameId;
  scopeNumber: number;
}

const enum SortOrder {
  Error = -1,
  Default = 0,
  Private = 1,
  Internal = 2,
}

const customStringReprMaxLength = 1024;

const identifierRe = /^[$a-z_][0-9a-z_$]*$/i;
const privatePropertyRe = /^#[0-9a-z_$]+$/i;

type AnyPropertyDescriptor = Cdp.Runtime.PropertyDescriptor | Cdp.Runtime.PrivatePropertyDescriptor;

const isPublicDescriptor = (p: AnyPropertyDescriptor): p is Cdp.Runtime.PropertyDescriptor =>
  p.hasOwnProperty('configurable');

const extractFunctionFromCustomGenerator = (
  parameterNames: string[],
  generatorDefinition: string,
  catchAndReturnErrors: boolean,
) => {
  const code = statementsToFunction(
    parameterNames,
    parseSource(generatorDefinition),
    catchAndReturnErrors,
  );
  return generate(code);
};

const indescribablePrefix = '<<indescribable>>';

const localizeIndescribable = (str: string) => {
  if (!str.startsWith(indescribablePrefix)) {
    return str;
  }

  let error;
  let key;
  try {
    [error, key] = JSON.parse(str.slice(indescribablePrefix.length));
  } catch {
    return str;
  }

  return l10n.t("{0} (couldn't describe: {1})", error, key);
};

/**
 * A "variable container" is a type that can be referenced in the DAP
 * `variables` request and may be capable of holding nested variables.
 * Specifically, this is implemented by both variables and scopes.
 */
export interface IVariableContainer {
  /**
   * An ID is assigned to _all_ variables. For variables that can be expanded,
   * this is also their variablesReference returned from `toDap()`.
   */
  readonly id: number;

  getChildren(params: Dap.VariablesParams): Promise<IVariable[]>;
}

/**
 * A variable container who also has a `Dap.Variable` representation.
 */
export interface IVariable extends IVariableContainer {
  readonly sortOrder: number;
  toDap(context: PreviewContextType, valueFormat?: Dap.ValueFormat): Promise<Dap.Variable>;
}

interface IMemoryReadable {
  readMemory(offset: number, count: number): Promise<Buffer | undefined>;
  writeMemory(offset: number, memory: Buffer): Promise<number>;
}

const isMemoryReadable = (t: unknown): t is IMemoryReadable =>
  !!t && typeof t === 'object' && 'readMemory' in t && 'writeMemory' in t;

/**
 * Configuration for the VariableStore. See the launch configuration docs
 * for details on these.
 */
export interface IStoreSettings {
  customDescriptionGenerator?: string;
  customPropertiesGenerator?: string;
}

type VariableCtor<TRestArgs extends unknown[] = unknown[], R extends IVariable = IVariable> = {
  new(context: VariableContext, ...rest: TRestArgs): R;
};

interface IContextInit {
  name: string;
  presentationHint?: Dap.VariablePresentationHint;
  /** How this variable should be sorted in results, in ascending numeric order. */
  sortOrder?: number;
}

interface IContextSettings {
  customDescriptionGenerator?: string;
  customPropertiesGenerator?: string;
  descriptionSymbols?: Promise<Cdp.Runtime.CallArgument>;
}

const wasmScopeNames: { [K in WasmScope]: { name: string; sortOrder: number } } = {
  [WasmScope.Parameter]: { name: l10n.t('Parameters'), sortOrder: -10 },
  [WasmScope.Local]: { name: l10n.t('Locals'), sortOrder: -9 },
  [WasmScope.Global]: { name: l10n.t('Globals'), sortOrder: -8 },
};

class VariableContext {
  /** When in a Variable, the name that this variable is accessible as from its parent scope or object */
  public readonly name: string;
  /** PresenationHint for this variable when displayed as a child of its parent/ */
  public readonly presentationHint?: Dap.VariablePresentationHint;
  /** Sort order set from the parent. */
  public readonly sortOrder: number;

  public get customDescriptionGenerator() {
    return this.settings.customDescriptionGenerator;
  }

  constructor(
    public readonly cdp: Cdp.Api,
    public readonly parent: undefined | IVariable | Scope,
    ctx: IContextInit,
    private readonly vars: VariablesMap,
    public readonly locationProvider: IVariableStoreLocationProvider,
    private readonly currentRef: undefined | (() => IVariable | Scope),
    private readonly settings: IContextSettings,
    public readonly clientCapabilities: IClientCapabilies,
  ) {
    this.name = ctx.name;
    this.presentationHint = ctx.presentationHint;
    this.sortOrder = ctx.sortOrder || SortOrder.Default;
  }

  /**
   * Creates and tracks a new Variable type.
   */
  public createVariable<T extends VariableCtor<[]>>(ctor: T, ctx: IContextInit): InstanceType<T>;
  public createVariable<A, T extends VariableCtor<[A]>>(
    ctor: T,
    ctx: IContextInit,
    a: A,
  ): InstanceType<T>;
  public createVariable<A, B, T extends VariableCtor<[A, B]>>(
    ctor: T,
    ctx: IContextInit,
    a: A,
    b: B,
  ): InstanceType<T>;
  public createVariable<A, B, C, T extends VariableCtor<[A, B, C]>>(
    ctor: T,
    ctx: IContextInit,
    a: A,
    b: B,
    c: C,
  ): InstanceType<T>;

  public createVariable<T extends VariableCtor>(
    ctor: T,
    ctx: IContextInit,
    ...rest: T extends VariableCtor<infer U> ? U : never
  ): InstanceType<T> {
    const v = new ctor(
      new VariableContext(
        this.cdp,
        this.currentRef?.(),
        ctx,
        this.vars,
        this.locationProvider,
        () => v,
        this.settings,
        this.clientCapabilities,
      ),
      ...rest,
    ) as InstanceType<T>;

    if (v.id > 0) {
      this.vars.add(v);
    }

    return v;
  }

  public createVariableByType(
    ctx: IContextInit,
    object: Cdp.Runtime.RemoteObject,
    customStringRepr?: string,
  ) {
    if (objectPreview.isArray(object)) {
      return this.createVariable(ArrayVariable, ctx, object);
    }

    if (object.objectId) {
      if (object.type === 'function') {
        return this.createVariable(FunctionVariable, ctx, object, customStringRepr);
      } else if (object.subtype === 'map' || object.subtype === 'set') {
        return this.createVariable(SetOrMapVariable, ctx, object, customStringRepr);
      } else if (object.subtype === 'node') {
        return this.createVariable(NodeVariable, ctx, object, customStringRepr);
      } else if (!objectPreview.subtypesWithoutPreview.has(object.subtype)) {
        return this.createVariable(ObjectVariable, ctx, object, customStringRepr);
      }
    }

    return this.createVariable(Variable, ctx, object);
  }

  /**
   * Ensures symbols for custom descriptions are available, must be used
   * before getStringProps/getToStringIfCustom
   */
  public async getDescriptionSymbols(objectId: string): Promise<Cdp.Runtime.CallArgument> {
    this.settings.descriptionSymbols ??= getDescriptionSymbols({
      cdp: this.cdp,
      args: [],
      objectId,
    }).then(
      r => ({ objectId: r.objectId }),
      () => ({ value: [] }),
    );

    return await this.settings.descriptionSymbols;
  }

  /**
   * Creates Variables for each property on the RemoteObject.
   */
  public async createObjectPropertyVars(
    object: Cdp.Runtime.RemoteObject,
    evaluationOptions?: Dap.EvaluationOptions,
  ): Promise<Variable[]> {
    const properties: (Promise<Variable[]> | Variable[])[] = [];

    if (this.settings.customPropertiesGenerator) {
      const { result, errorDescription } = await this.evaluateCodeForObject(
        object,
        this.settings.customPropertiesGenerator,
        [],
      );

      if (result && result.type !== 'undefined') {
        object = result;
      } else {
        properties.push([
          this.createVariable(
            ErrorVariable,
            { name: '', sortOrder: SortOrder.Error },
            result as Cdp.Runtime.RemoteObject,
            result?.description || errorDescription || l10n.t('Unknown error'),
          ),
        ]);
      }
    }

    if (!object.objectId) {
      return [];
    }

    if (evaluationOptions) {
      this.cdp.DotnetDebugger.setEvaluationOptions({
        options: evaluationOptions,
        type: 'variable',
      });
    }

    const [accessorsProperties, ownProperties, stringyProps] = await Promise.all([
      this.cdp.Runtime.getProperties({
        objectId: object.objectId,
        accessorPropertiesOnly: true,
        ownProperties: false,
        generatePreview: true,
      }),
      this.cdp.Runtime.getProperties({
        objectId: object.objectId,
        ownProperties: true,
        generatePreview: true,
      }),
      this.cdp.Runtime.callFunctionOn({
        functionDeclaration: getStringyProps.decl(
          `${customStringReprMaxLength}`,
          this.settings.customDescriptionGenerator || 'null',
        ),
        arguments: [await this.getDescriptionSymbols(object.objectId)],
        objectId: object.objectId,
        throwOnSideEffect: true,
        returnByValue: true,
      })
        .then(r => r?.result.value || {})
        .catch(() => ({} as Record<string, string>)),
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
        property.name === '__proto__'
        && ownProperties.internalProperties?.some(p => p.name === '[[Prototype]]')
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

    // Push own properties & accessors and symbols
    for (const propertiesCollection of [propertiesMap.values(), propertySymbols.values()]) {
      for (const p of propertiesCollection) {
        properties.push(
          this.createPropertyVar(
            p,
            object,
            stringyProps?.hasOwnProperty(p.name)
              ? localizeIndescribable(stringyProps[p.name])
              : undefined,
          ),
        );
      }
    }

    for (const property of ownProperties.privateProperties ?? []) {
      properties.push(
        this.createPropertyVar(property, object, undefined, {
          presentationHint: { visibility: 'private' },
          sortOrder: SortOrder.Private,
        }),
      );
    }

    // Push internal properties
    for (const p of ownProperties.internalProperties || []) {
      if (p.name === '[[StableObjectId]]') {
        continue;
      }

      let variable: Variable | undefined;
      if (
        p.name === '[[FunctionLocation]]'
        && p.value
        && (p.value.subtype as string) === 'internal#location'
      ) {
        variable = this.createVariable(
          FunctionLocationVariable,
          {
            name: p.name,
            presentationHint: { visibility: 'internal', attributes: ['readOnly'] },
            sortOrder: SortOrder.Internal,
          },
          p.value,
        );
      } else if (p.value !== undefined) {
        variable = this.createVariableByType(
          {
            name: p.name,
            presentationHint: { visibility: 'internal' },
            sortOrder: SortOrder.Internal,
          },
          p.value,
        );
      }

      if (variable) {
        properties.push([variable]);
      }
    }

    return flatten(await Promise.all(properties));
  }

  private async createPropertyVar(
    p: AnyPropertyDescriptor,
    owner: Cdp.Runtime.RemoteObject,
    customStringRepr: string | undefined,
    contextInit?: Partial<IContextInit>,
  ): Promise<Variable[]> {
    const result: Variable[] = [];
    const hasGetter = p.get && p.get.type !== 'undefined';
    const hasSetter = p.set && p.set.type !== 'undefined';

    const ctx: Required<IContextInit> = {
      name: p.name,
      presentationHint: {},
      sortOrder: SortOrder.Default,
      ...contextInit,
    };

    if (!contextInit) {
      if (isPublicDescriptor(p)) {
        // sort non-enumerable properties as private, except for getters, which
        // are automatically non-enumerable but not (automatically) considered private (#1215)
        if (p.enumerable === false && !hasGetter) {
          ctx.presentationHint.visibility = 'internal';
          ctx.sortOrder = SortOrder.Private;
        }
        if (p.writable === false || (hasGetter && !hasSetter)) {
          ctx.presentationHint.attributes = ['readOnly'];
        }
      } else {
        ctx.presentationHint.visibility = 'private';
        ctx.sortOrder = SortOrder.Private;
      }
    }

    // If the value is simply present, add that
    if ('value' in p && p.value) {
      result.push(this.createVariableByType(ctx, p.value, customStringRepr));
    }

    // if it's a getter, auto expand as requested
    if (hasGetter) {
      result.push(
        this.createVariable(GetterVariable, ctx, p.get as Cdp.Runtime.RemoteObject, owner),
      );
    } else if (hasSetter) {
      result.push(
        this.createVariable(SetterOnlyVariable, ctx, p.set as Cdp.Runtime.RemoteObject),
      );
    }

    return result;
  }

  private async evaluateCodeForObject(
    object: Cdp.Runtime.RemoteObject,
    functionDeclaration: string,
    argumentsToEvaluateWith: string[],
  ): Promise<{ result?: Cdp.Runtime.RemoteObject; errorDescription?: string }> {
    try {
      const customValueDescription = await this.cdp.Runtime.callFunctionOn({
        objectId: object.objectId,
        functionDeclaration,
        arguments: argumentsToEvaluateWith.map(toCallArgument),
      });

      if (customValueDescription) {
        if (customValueDescription.exceptionDetails === undefined) {
          return { result: customValueDescription.result };
        } else if (customValueDescription && customValueDescription.result.description) {
          return { errorDescription: customValueDescription.result.description };
        }
      }
      return { errorDescription: l10n.t('Unknown error') };
    } catch (e) {
      return { errorDescription: e.stack || e.message || String(e) };
    }
  }
}

const isNumberOrNumeric = (s: string | number) => typeof s === 'number' || /^[0-9]+$/.test(s);

class Variable implements IVariable {
  public id = getVariableId();

  /** Gets the variable name in its parent scope or object. */
  public get name() {
    return this.context.name;
  }

  /** Gets the presentation hint set by the parent. */
  public get sortOrder() {
    return this.context.sortOrder;
  }

  constructor(
    protected readonly context: VariableContext,
    public readonly remoteObject: Cdp.Runtime.RemoteObject,
  ) {}

  /**
   * Gets the accessor though which this object can be read.
   */
  public get accessor(): string {
    const { parent, name } = this.context;
    if (parent instanceof AccessorVariable) {
      return parent.accessor;
    }

    if (!(parent instanceof Variable)) {
      return this.context.name;
    }

    // Maps and sets:
    const grandparent = parent.context.parent;
    if (grandparent instanceof Variable) {
      if ((this.remoteObject.subtype as string) === 'internal#entry') {
        return `[...${grandparent.accessor}.entries()][${+name}]`;
      }

      if ((parent.remoteObject.subtype as string) === 'internal#entry') {
        return `${parent.accessor}[${this.name === 'key' ? 0 : 1}]`;
      }
    }

    if (isNumberOrNumeric(name)) {
      return `${parent.accessor}[${name}]`;
    }

    // If the object property looks like a valid identifer, don't use the
    // bracket syntax -- it's ugly!
    if (identifierRe.test(name)) {
      return `${parent.accessor}.${name}`;
    }

    if (parent.accessor === 'this' && privatePropertyRe.test(name)) {
      return `${parent.accessor}.${name}`;
    }

    return `${parent.accessor}[${JSON.stringify(name)}]`;
  }

  /** @inheritdoc */
  public async toDap(
    previewContext: PreviewContextType,
    valueFormat?: Dap.ValueFormat,
  ): Promise<Dap.Variable> {
    let name = this.context.name;
    if (this.context.parent instanceof Scope) {
      name = await this.context.parent.getRename(name);
    }

    return Promise.resolve({
      name,
      value: objectPreview.previewRemoteObject(this.remoteObject, previewContext, valueFormat),
      evaluateName: this.accessor,
      type: this.remoteObject.type,
      variablesReference: 0,
      presentationHint: this.context.presentationHint,
    });
  }

  /** Sets a property of the variable variable. */
  public async setProperty(name: string, expression: string): Promise<Variable> {
    const result = await this.context.cdp.Runtime.callFunctionOn({
      objectId: this.remoteObject.objectId,
      functionDeclaration: `function(a) { return this[a] = ${expression}; ${getSourceSuffix()} }`,
      arguments: [toCallArgument(name)],
      silent: true,
    });

    if (!result) {
      throw new ProtocolError(errors.createSilentError(l10n.t('Unable to set variable value')));
    }

    if (result.exceptionDetails) {
      throw new ProtocolError(errorFromException(result.exceptionDetails));
    }

    return this.context.createVariableByType({ name }, result.result);
  }

  public async getChildren(_params: Dap.VariablesParams): Promise<Variable[]> {
    return Promise.resolve([]);
  }
}

class OutputVariableContainer implements IVariableContainer {
  public readonly id = getVariableId();

  constructor(private readonly child: Variable) {}

  public getChildren(): Promise<IVariable[]> {
    return Promise.resolve([this.child]);
  }
}

class OutputVariable extends Variable {
  constructor(
    context: VariableContext,
    private readonly value: string,
    private readonly args: ReadonlyArray<Cdp.Runtime.RemoteObject>,
    private readonly stackTrace: StackTrace | undefined,
  ) {
    super(context, { type: args[0]?.type ?? 'string' });
  }

  public override toDap(): Promise<Dap.Variable> {
    return Promise.resolve({
      name: this.context.name,
      value: this.value,
      variablesReference: this.stackTrace || this.args.some(objectPreview.previewAsObject)
        ? this.id
        : 0,
    });
  }

  public override getChildren(_params: Dap.VariablesParams): Promise<Variable[]> {
    const vars: Variable[] = [];
    const { args, stackTrace } = this;
    for (let i = 0; i < args.length; ++i) {
      if (objectPreview.previewAsObject(args[i])) {
        vars.push(this.context.createVariableByType({ name: `arg${i}`, sortOrder: i }, args[i]));
      }
    }

    if (stackTrace) {
      vars.push(
        this.context.createVariable(
          StacktraceOutputVariable,
          { name: '', sortOrder: Number.MAX_SAFE_INTEGER },
          this.remoteObject,
          stackTrace,
        ),
      );
    }

    return Promise.resolve(vars);
  }
}

class StacktraceOutputVariable extends Variable {
  constructor(
    context: VariableContext,
    remoteObject: Cdp.Runtime.RemoteObject,
    private readonly stacktrace: StackTrace,
  ) {
    super(context, remoteObject);
  }

  public override async toDap(): Promise<Dap.Variable> {
    return {
      name: '',
      value: await this.stacktrace.format(),
      variablesReference: 0,
    };
  }
}

class FunctionLocationVariable extends Variable {
  public readonly location: Cdp.Debugger.Location;

  constructor(context: VariableContext, remoteObject: Cdp.Runtime.RemoteObject) {
    super(context, remoteObject);
    this.location = remoteObject.value;
  }

  public override async toDap(): Promise<Dap.Variable> {
    return {
      name: this.context.name,
      value: await this.context.locationProvider.renderDebuggerLocation(this.location),
      variablesReference: 0,
      presentationHint: { visibility: 'internal' },
    };
  }
}

class ErrorVariable extends Variable {
  public override get accessor(): string {
    if (!(this.context.parent instanceof Variable)) {
      throw new Error('ErrorVariable must have a parent Variable');
    }

    return this.context.parent.accessor;
  }

  constructor(
    context: VariableContext,
    remoteObject: Cdp.Runtime.RemoteObject,
    private readonly message: string,
  ) {
    super(context, remoteObject);
  }

  public override toDap(): Promise<Dap.Variable> {
    return Promise.resolve({
      name: this.context.name,
      value: this.message,
      variablesReference: 0,
    });
  }
}

const NoCustomStringRepr = Symbol('NoStringRepr');

class ObjectVariable extends Variable implements IMemoryReadable {
  constructor(
    context: VariableContext,
    remoteObject: Cdp.Runtime.RemoteObject,
    private customStringRepr?: string | typeof NoCustomStringRepr,
  ) {
    super(context, remoteObject);
  }

  public override async toDap(
    previewContext: PreviewContextType,
    valueFormat?: Dap.ValueFormat,
  ): Promise<Dap.Variable> {
    const [parentDap, value] = await Promise.all([
      await super.toDap(previewContext, valueFormat),
      await this.getValueRepresentation(previewContext),
    ]);

    return {
      ...parentDap,
      type: this.remoteObject.className || this.remoteObject.subtype || this.remoteObject.type,
      variablesReference: this.id,
      memoryReference: memoryReadableTypes.has(this.remoteObject.subtype)
        ? String(this.id)
        : undefined,
      value,
    };
  }

  private async getValueRepresentation(previewContext: PreviewContextType) {
    if (typeof this.customStringRepr === 'string') {
      return this.customStringRepr;
    }

    // for the first level of evaluations, toString it on-demand
    if (
      !this.context.parent
      && this.remoteObject.objectId
      && this.customStringRepr !== NoCustomStringRepr
    ) {
      try {
        const ret = await this.context.cdp.Runtime.callFunctionOn({
          functionDeclaration: getToStringIfCustom.decl(
            `${customStringReprMaxLength}`,
            this.context.customDescriptionGenerator || 'null',
          ),
          objectId: this.remoteObject.objectId,
          returnByValue: true,
        });
        if (ret?.result.value) {
          return (this.customStringRepr = localizeIndescribable(ret.result.value));
        }
      } catch (e) {
        this.customStringRepr = NoCustomStringRepr;
        // ignored
      }
    }

    return (
      (this.context.name === '__proto__' && this.remoteObject.description)
      || objectPreview.previewRemoteObject(this.remoteObject, previewContext)
    );
  }

  /** @inheritdoc */
  public async readMemory(offset: number, count: number): Promise<Buffer | undefined> {
    const result = await readMemory({
      cdp: this.context.cdp,
      args: [offset, count],
      objectId: this.remoteObject.objectId,
      returnByValue: true,
    });

    return Buffer.from(result.value, 'hex');
  }

  /** @inheritdoc */
  public async writeMemory(offset: number, memory: Buffer): Promise<number> {
    const result = await writeMemory({
      cdp: this.context.cdp,
      args: [offset, memory.toString('hex')],
      objectId: this.remoteObject.objectId,
      returnByValue: true,
    });

    return result.value;
  }

  public override getChildren(_params: Dap.VariablesParamsExtended) {
    return this.context.createObjectPropertyVars(this.remoteObject, _params.evaluationOptions);
  }
}

class NodeAttributes extends ObjectVariable {
  public readonly id = getVariableId();

  override get accessor(): string {
    return (this.context.parent as NodeVariable).accessor;
  }

  public override async toDap(
    context: PreviewContextType,
    valueFormat?: Dap.ValueFormat,
  ): Promise<Dap.Variable> {
    return Promise.resolve({
      ...await super.toDap(context, valueFormat),
      value: '...',
    });
  }
}

class NodeVariable extends Variable {
  public override async toDap(
    previewContext: PreviewContextType,
    valueFormat?: Dap.ValueFormat,
  ): Promise<Dap.Variable> {
    const description = await this.description();
    const length = description?.node?.childNodeCount || 0;
    return {
      ...await super.toDap(previewContext, valueFormat),
      value: await this.getValuePreview(previewContext),
      variablesReference: this.id,
      indexedVariables: length > 100 ? length : undefined,
      namedVariables: length > 100 ? 1 : undefined,
    };
  }

  public override async getChildren(params?: Dap.VariablesParamsExtended): Promise<Variable[]> {
    switch (params?.filter) {
      case 'indexed':
        return this.getNodeChildren(params.start, params.count);
      case 'named':
        return [this.getAttributesVar()];
      default:
        return [this.getAttributesVar(), ...(await this.getNodeChildren())];
    }
  }

  private getAttributesVar() {
    return this.context.createVariable(
      NodeAttributes,
      {
        name: l10n.t('Node Attributes'),
        presentationHint: { visibility: 'internal' },
        sortOrder: Number.MAX_SAFE_INTEGER,
      },
      this.remoteObject,
      undefined,
    );
  }

  private async getNodeChildren(start = -1, count = -1) {
    let slotsObject: Cdp.Runtime.RemoteObject;
    try {
      slotsObject = await getNodeChildren({
        cdp: this.context.cdp,
        generatePreview: false,
        args: [start, count],
        objectId: this.remoteObject.objectId,
      });
    } catch (e) {
      return [];
    }

    const result = await this.context.createObjectPropertyVars(slotsObject);
    if (slotsObject.objectId) {
      await this.context.cdp.Runtime.releaseObject({ objectId: slotsObject.objectId });
    }

    return result;
  }

  private readonly description = once(() =>
    this.context.cdp.DOM.describeNode({
      objectId: this.remoteObject.objectId,
    })
  );

  private async getValuePreview(_previewContext: PreviewContextType) {
    const description = await this.description();
    if (!description?.node) {
      return '';
    }

    const { localName, attributes, childNodeCount } = description.node;
    const styleCheck = this.context.clientCapabilities.value?.supportsANSIStyling ? true : '';
    let str = (styleCheck && AnsiStyles.Blue) + `<${localName}`;
    if (attributes) {
      for (let i = 0; i < attributes.length; i += 2) {
        const key = attributes[i];
        const value = attributes[i + 1];
        str += ` ${(styleCheck && AnsiStyles.BrightBlue)}${key}${(styleCheck
          && AnsiStyles.Dim)}=${(styleCheck && AnsiStyles.Yellow)}${JSON.stringify(value)}`;
      }
    }
    str += (styleCheck && AnsiStyles.Blue) + '>';
    if (childNodeCount) {
      str += `${(styleCheck && AnsiStyles.Dim)}...${(styleCheck && AnsiStyles.Blue)}`;
    }
    str += `</${localName}>${(styleCheck && AnsiStyles.Reset)}`;

    return str;
  }
}

class FunctionVariable extends ObjectVariable {
  private readonly baseChildren = once(() => super.getChildren({ variablesReference: this.id }));

  public override async toDap(previewContext: PreviewContextType): Promise<Dap.Variable> {
    const [dap, children] = await Promise.all([
      super.toDap(previewContext),
      this.baseChildren(),
    ]);

    if (children.some(c => c instanceof FunctionLocationVariable)) {
      dap.valueLocationReference = this.id;
    }

    return dap;
  }
}

const entriesVariableName = '[[Entries]]';

class SetOrMapVariable extends ObjectVariable {
  private readonly size?: number;
  public readonly isMap: boolean;
  private readonly baseChildren = once(() => super.getChildren({ variablesReference: this.id }));

  constructor(context: VariableContext, remoteObject: Cdp.Runtime.RemoteObject) {
    super(context, remoteObject, NoCustomStringRepr);
    this.isMap = remoteObject.subtype === 'map';
    const cast = remoteObject.preview as MapPreview | SetPreview | undefined;
    this.size = Number(cast?.properties.find(p => p.name === 'size')?.value) ?? undefined;
  }

  public override async toDap(previewContext: PreviewContextType): Promise<Dap.Variable> {
    const dap = await super.toDap(previewContext);
    if (this.size && this.size > 100) {
      dap.indexedVariables = this.size;
    }

    return dap;
  }

  public override async getChildren(params: Dap.VariablesParams): Promise<Variable[]> {
    const baseChildren = await this.baseChildren();
    const entryChildren = await baseChildren
      .find(c => c.name === entriesVariableName)
      ?.getChildren(params);

    return [
      // filter to only show the actualy entries, not the array prototype/length
      ...(entryChildren || []).filter(v => v.sortOrder === SortOrder.Default),
      ...baseChildren.filter(c => c.name !== entriesVariableName),
    ];
  }
}

class ArrayVariable extends ObjectVariable {
  private length = 0;

  constructor(context: VariableContext, remoteObject: Cdp.Runtime.RemoteObject) {
    super(context, remoteObject, NoCustomStringRepr);
    const match = String(remoteObject.description).match(/\(([0-9]+)\)/);
    this.length = match ? +match[1] : 0;
  }

  public override async toDap(previewContext: PreviewContextType): Promise<Dap.Variable> {
    return {
      ...(await super.toDap(previewContext)),
      indexedVariables: this.length > 100 ? this.length : undefined,
      namedVariables: this.length > 100 ? 1 : undefined, // do not count properties proactively
    };
  }

  public override async getChildren(params: Dap.VariablesParams): Promise<Variable[]> {
    switch (params?.filter) {
      case 'indexed':
        return this.getArraySlots(params);
      case 'named':
        return this.getArrayProperties();
      default:
        return Promise.all([this.getArrayProperties(), this.getArraySlots()]).then(flatten);
    }
  }

  private async getArrayProperties(): Promise<Variable[]> {
    try {
      const object = await getArrayProperties({
        cdp: this.context.cdp,
        args: [],
        objectId: this.remoteObject.objectId,
        generatePreview: true,
      });

      return this.context.createObjectPropertyVars(object);
    } catch (e) {
      return [];
    }
  }

  private async getArraySlots(params?: Dap.VariablesParams): Promise<Variable[]> {
    const start = params && typeof params.start !== 'undefined' ? params.start : -1;
    const count = params && typeof params.count !== 'undefined' ? params.count : -1;
    let slotsObject: Cdp.Runtime.RemoteObject;
    try {
      slotsObject = await getArraySlots({
        cdp: this.context.cdp,
        generatePreview: false,
        args: [start, count],
        objectId: this.remoteObject.objectId,
      });
    } catch (e) {
      return [];
    }

    const result = await this.context.createObjectPropertyVars(slotsObject);
    if (slotsObject.objectId) {
      await this.context.cdp.Runtime.releaseObject({ objectId: slotsObject.objectId });
    }

    return result;
  }
}

class OutputTableVariable extends ArrayVariable {
  public override async toDap(previewContext: PreviewContextType): Promise<Dap.Variable> {
    if (!this.remoteObject.preview) {
      return super.toDap(previewContext);
    }

    return {
      ...(await super.toDap(previewContext)),
      name: objectPreview.formatAsTable(this.remoteObject.preview),
    };
  }
}

abstract class AccessorVariable extends Variable {
  constructor(context: VariableContext, remoteObject: Cdp.Runtime.RemoteObject) {
    super(context, remoteObject);
  }

  public override getChildren(_params: Dap.VariablesParams) {
    return this.context.createObjectPropertyVars(this.remoteObject);
  }
}

class SetterOnlyVariable extends AccessorVariable {
  public override async toDap(
    previewContext: PreviewContextType,
    valueFormat?: Dap.ValueFormat,
  ): Promise<Dap.Variable> {
    return {
      ...(await super.toDap(previewContext, valueFormat)),
      value: 'write-only',
      variablesReference: this.id,
    };
  }
}

class GetterVariable extends AccessorVariable {
  constructor(
    context: VariableContext,
    remoteObject: Cdp.Runtime.RemoteObject,
    private readonly parentObject: Cdp.Runtime.RemoteObject,
  ) {
    super(context, remoteObject);
  }

  public override async toDap(
    previewContext: PreviewContextType,
    valueFormat?: Dap.ValueFormat,
  ): Promise<Dap.Variable> {
    const dap = await super.toDap(previewContext, valueFormat);
    dap.variablesReference = this.id;
    dap.presentationHint = { ...dap.presentationHint, lazy: true };
    return dap;
  }

  public override async getChildren(params: Dap.VariablesParams) {
    try {
      const result = await invokeGetter({
        cdp: this.context.cdp,
        objectId: this.parentObject.objectId,
        // object ID is always set for functions:
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        args: [new RemoteObjectId(this.remoteObject.objectId!)],
      });

      return [
        this.context.createVariableByType(
          { name: this.name, presentationHint: this.context.presentationHint },
          result,
        ),
      ];
    } catch (e) {
      if (!(e instanceof RemoteException)) {
        throw e;
      }
    }

    return super.getChildren(params);
  }
}

class WasmVariable implements IVariable, IMemoryReadable {
  public static presentationHint: Dap.VariablePresentationHint = {
    attributes: ['readOnly'],
  };

  /** @inheritdoc */
  public readonly id = getVariableId();

  /** @inheritdoc */
  public readonly sortOrder = 0;

  constructor(
    private readonly context: VariableContext,
    private readonly variable: IWasmVariableEvaluation,
    private readonly scopeRef: IScopeRef,
  ) {}

  public toDap(): Promise<Dap.Variable> {
    return Promise.resolve({
      name: this.context.name,
      value: this.variable.description || '',
      variablesReference: this.variable.getChildren ? this.id : 0,
      memoryReference: this.variable.linearMemoryAddress ? String(this.id) : undefined,
      presentationHint: this.context.presentationHint,
    });
  }

  public async getChildren(): Promise<IVariable[]> {
    const children = (await this.variable.getChildren?.()) || [];
    return children.map(c =>
      this.context.createVariable(
        WasmVariable,
        { name: c.name, presentationHint: WasmVariable.presentationHint },
        c.value,
        this.scopeRef,
      )
    );
  }

  /** @inheritdoc */
  public async readMemory(offset: number, count: number): Promise<Buffer | undefined> {
    const addr = this.variable.linearMemoryAddress;
    if (addr === undefined) {
      return undefined;
    }

    const result = await this.context.cdp.Debugger.evaluateOnCallFrame({
      callFrameId: this.scopeRef.callFrameId,
      expression: `(${readMemory.source}).call(memories[0].buffer, ${
        +addr + offset
      }, ${+count}) ${getSourceSuffix()}`,
      returnByValue: true,
    });

    if (!result) {
      throw new RemoteException({
        exceptionId: 0,
        text: 'No response from CDP',
        lineNumber: 0,
        columnNumber: 0,
      });
    }

    return Buffer.from(result.result.value, 'hex');
  }

  /** @inheritdoc */
  public async writeMemory(offset: number, memory: Buffer): Promise<number> {
    const addr = this.variable.linearMemoryAddress;
    if (addr === undefined) {
      return 0;
    }

    const result = await this.context.cdp.Debugger.evaluateOnCallFrame({
      callFrameId: this.scopeRef.callFrameId,
      expression: `(${writeMemory.source}).call(memories[0].buffer, ${+addr + offset}, ${
        JSON.stringify(memory.toString('hex'))
      }) ${getSourceSuffix()}`,
      returnByValue: true,
    });

    return result?.result.value || 0;
  }
}

class WasmScopeVariable implements IVariable {
  /** @inheritdoc */
  public readonly id = getVariableId();

  /** @inheritdoc */
  public readonly sortOrder = wasmScopeNames[this.kind]?.sortOrder || 0;

  constructor(
    private readonly context: VariableContext,
    public readonly kind: WasmScope,
    private readonly variables: readonly IWasmVariable[],
    private readonly scopeRef: IScopeRef,
  ) {}

  toDap(): Promise<Dap.Variable> {
    return Promise.resolve({
      name: wasmScopeNames[this.kind]?.name || this.kind,
      value: '',
      variablesReference: this.id,
    });
  }

  getChildren(): Promise<IVariable[]> {
    return Promise.all(
      this.variables.map(async v => {
        const evaluated = await v.evaluate();
        return this.context.createVariable(
          WasmVariable,
          {
            name: v.name,
            presentationHint: WasmVariable.presentationHint,
          },
          evaluated,
          this.scopeRef,
        );
      }),
    );
  }
}

class Scope implements IVariableContainer {
  /** @inheritdoc */
  public readonly id = getVariableId();

  constructor(
    public readonly remoteObject: Cdp.Runtime.RemoteObject,
    private readonly context: VariableContext,
    public readonly ref: IScopeRef,
    private readonly extraProperties: IExtraProperty[],
    private readonly renameProvider: IRenameProvider,
  ) {}

  public async getChildren(_params: Dap.VariablesParams): Promise<IVariable[]> {
    const variables = await this.context.createObjectPropertyVars(this.remoteObject);
    const existing = new Set(variables.map(v => v.name));
    for (const extraProperty of this.extraProperties) {
      if (!existing.has(extraProperty.name)) {
        variables.push(
          this.context.createVariableByType({ name: extraProperty.name }, extraProperty.value),
        );
      }
    }

    return variables;
  }

  /** Maps any rename for the identifier in the current scope. */
  public async getRename(forIdentifier: string) {
    const renames = await this.renameProvider.provideOnStackframe(this.ref.stackFrame);
    return renames.getOriginalName(forIdentifier, this.ref.stackFrame.rawPosition)
      || forIdentifier;
  }

  /** Sets a property of the scope */
  public async setProperty(name: string, expression: string): Promise<Variable> {
    const evaluated = await this.context.cdp.Debugger.evaluateOnCallFrame({
      expression: `${expression} ${getSourceSuffix()}`,
      callFrameId: this.ref.callFrameId,
    });
    if (!evaluated) {
      throw new ProtocolError(errors.createUserError(l10n.t('Invalid expression')));
    }
    if (evaluated.exceptionDetails) {
      throw new ProtocolError(errorFromException(evaluated.exceptionDetails));
    }

    await this.context.cdp.Debugger.setVariableValue({
      callFrameId: this.ref.callFrameId,
      scopeNumber: this.ref.scopeNumber,
      variableName: name,
      newValue: toCallArgument(evaluated.result),
    });

    return this.context.createVariableByType({ name }, evaluated.result);
  }
}

export interface IExtraProperty {
  name: string;
  value: Cdp.Runtime.RemoteObject;
}

class VariablesMap {
  private readonly value = new Map<number, IVariableContainer>();

  public get(variablesReference: number) {
    return this.value.get(variablesReference);
  }

  public add(container: IVariableContainer) {
    this.value.set(container.id, container);
  }

  public clear() {
    this.value.clear();
  }
}

/**
 * A VariableStore has a collection of variables. A debug session may have many
 * instances of VariableStore through its lifetime. A VariableStore will always
 * be kept for the Debug Console, and time the debugger stops a new
 * VariableStore will be created to represent variables for the call stack.
 */
@injectable()
export class VariableStore {
  private vars = new VariablesMap();
  private readonly contextSettings: IContextSettings;

  constructor(
    @inject(IRenameProvider) private readonly renameProvider: IRenameProvider,
    @inject(ICdpApi) private readonly cdp: Cdp.Api,
    @inject(IDapApi) private readonly dap: Dap.Api,
    @inject(AnyLaunchConfiguration) private readonly launchConfig: AnyLaunchConfiguration,
    @inject(ClientCapabilities) private readonly clientCapabilities: ClientCapabilities,
    private readonly locationProvider: IVariableStoreLocationProvider,
  ) {
    this.contextSettings = {
      customDescriptionGenerator: launchConfig.customDescriptionGenerator
        && extractFunctionFromCustomGenerator(
          ['defaultValue'],
          launchConfig.customDescriptionGenerator,
          false,
        ),
      customPropertiesGenerator: launchConfig.customPropertiesGenerator
        && extractFunctionFromCustomGenerator([], launchConfig.customPropertiesGenerator, false),
    };
  }

  /** Creates a new VariableStore using the current DAP, CDP, and configurations. */
  public createDetached() {
    return new VariableStore(
      this.renameProvider,
      this.cdp,
      this.dap,
      this.launchConfig,
      this.clientCapabilities,
      this.locationProvider,
    );
  }

  /** Clears all scopes and variables. */
  public clear() {
    this.vars.clear();
  }

  /** Creates a variable not attached to any specific scope. */
  public createFloatingVariable(expression: string, value: Cdp.Runtime.RemoteObject): IVariable {
    const ctx = this.createFloatingContext();
    return ctx.createVariableByType({ name: expression }, value);
  }

  /**
   * Returns the variable reference for a complex, object-including output.
   */
  public createVariableForOutput(
    text: string,
    args: ReadonlyArray<Cdp.Runtime.RemoteObject>,
    stackTrace?: StackTrace,
    outputType?: Cdp.Runtime.ConsoleAPICalledEvent['type'],
  ): IVariableContainer {
    const ctx = this.createFloatingContext();
    const output = args.length === 1 && outputType === 'table'
      ? ctx.createVariable(OutputTableVariable, { name: '' }, args[0])
      : args.length === 1 && objectPreview.previewAsObject(args[0]) && !stackTrace
      ? ctx.createVariableByType({ name: '' }, args[0])
      : ctx.createVariable(OutputVariable, { name: '' }, text, args, stackTrace);
    const container = new OutputVariableContainer(output);
    this.vars.add(container);

    return container;
  }

  /** Creates a container for a CDP Scope */
  public createScope(
    value: Cdp.Runtime.RemoteObject,
    scopeRef: IScopeRef,
    extraProperties: IExtraProperty[],
  ): IVariableContainer {
    const scope: Scope = new Scope(
      value,
      new VariableContext(
        this.cdp,
        undefined,
        { name: '' },
        this.vars,
        this.locationProvider,
        () => scope,
        this.contextSettings,
        this.clientCapabilities,
      ),
      scopeRef,
      extraProperties,
      this.renameProvider,
    );

    this.vars.add(scope);

    return scope;
  }

  /** Creates a container for a CDP Scope */
  public createWasmScope(
    kind: WasmScope,
    variables: readonly IWasmVariable[],
    scopeRef: IScopeRef,
  ): IVariable {
    const scope: WasmScopeVariable = new WasmScopeVariable(
      new VariableContext(
        this.cdp,
        undefined,
        { name: '' },
        this.vars,
        this.locationProvider,
        () => scope,
        this.contextSettings,
        this.clientCapabilities,
      ),
      kind,
      variables,
      scopeRef,
    );

    this.vars.add(scope);

    return scope;
  }

  /** Gets whether the variablesReference exists in this store */
  public hasVariable(variablesReference: number) {
    return !!this.vars.get(variablesReference);
  }

  /** Gets whether the memoryReference exists in this store */
  public hasMemory(memoryReference: string) {
    return isMemoryReadable(this.vars.get(Number(memoryReference)));
  }

  /** Writes memory from the reference at the offset and count */
  public async readMemory(memoryReference: string, offset: number, count: number) {
    const variable = this.vars.get(Number(memoryReference));
    return isMemoryReadable(variable) ? variable.readMemory(offset, count) : undefined;
  }

  /** Reads memory from the reference at the offset and count */
  public async writeMemory(memoryReference: string, offset: number, memory: Buffer) {
    const variable = this.vars.get(Number(memoryReference));
    const written = isMemoryReadable(variable) ? await variable.writeMemory(offset, memory) : 0;
    if (written > 0) {
      this.dap.invalidated({ areas: ['variables'] });
    }

    return written;
  }

  /**
   * Gets variable names from a known {@link IVariableContainer}. An optimized
   * version of `getVariables` that saves work generating previews.
   */
  public async getVariableNames(
    params: Dap.VariablesParams,
  ): Promise<{ name: string; remoteObject: Cdp.Runtime.RemoteObject }[]> {
    const container = this.vars.get(params.variablesReference);
    if (!container) {
      return [];
    }

    const children = await container.getChildren(params);
    return children.filter(isInstanceOf(Variable));
  }

  /** Gets variables from a known {@link IVariableContainer} */
  public async getVariables(params: Dap.VariablesParams): Promise<Dap.Variable[]> {
    const container = this.vars.get(params.variablesReference);
    if (!container) {
      return [];
    }

    const children = await container.getChildren(params);
    const daps = await Promise.all(
      children.map(v =>
        v
          .toDap(
            container instanceof Scope || container instanceof OutputVariableContainer
              ? PreviewContextType.Repl
              : PreviewContextType.PropertyValue,
            params.format,
          )
          .then(dap => ({ v, dap }))
      ),
    );

    return daps
      .sort(
        (a, b) =>
          a.v.sortOrder - b.v.sortOrder
          || +a.dap.name - +b.dap.name
          || a.dap.name.localeCompare(b.dap.name),
      )
      .map(v => v.dap);
  }

  public async getLocations(variablesReference: number): Promise<Cdp.Debugger.Location> {
    const container = this.vars.get(variablesReference);
    if (!container) {
      throw errors.locationNotFound();
    }

    // note: is actually free because the container will have cached its children
    const children = await container.getChildren({ variablesReference });
    const locationVar = children.find(isInstanceOf(FunctionLocationVariable));
    if (!locationVar) {
      throw errors.locationNotFound();
    }

    return locationVar.location;
  }

  /** Sets a variable */
  public async setVariable(params: Dap.SetVariableParams): Promise<Dap.SetVariableResult> {
    const container = this.vars.get(params.variablesReference);

    if (!params.value) {
      throw new ProtocolError(errors.createUserError(l10n.t('Cannot set an empty value')));
    }

    if (container instanceof Scope || container instanceof Variable) {
      const newVar = await container.setProperty(params.name, params.value);
      return await newVar.toDap(PreviewContextType.PropertyValue, params.format);
    } else {
      throw new ProtocolError(errors.createSilentError(l10n.t('Variable not found')));
    }
  }

  private createFloatingContext() {
    return new VariableContext(
      this.cdp,
      undefined,
      { name: '<unnamed>' },
      this.vars,
      this.locationProvider,
      undefined,
      this.contextSettings,
      this.clientCapabilities,
    );
  }
}

function errorFromException(details: Cdp.Runtime.ExceptionDetails): Dap.Error {
  const message = (details.exception && objectPreview.previewException(details.exception).title)
    || details.text;
  return errors.createUserError(message);
}
