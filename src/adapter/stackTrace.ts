/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import Cdp from '../cdp/api';
import { groupBy } from '../common/arrayUtils';
import { once, posInt32Counter, truthy } from '../common/objUtils';
import { Base0Position, Base1Position, IPosition, Range } from '../common/positions';
import { SourceConstants } from '../common/sourceUtils';
import Dap from '../dap/api';
import { asyncScopesNotAvailable } from '../dap/errors';
import { ProtocolError } from '../dap/protocolError';
import { WasmScope } from './dwarf/wasmSymbolProvider';
import { PreviewContextType } from './objectPreview/contexts';
import { StepDirection } from './pause';
import { shouldStepOverStackFrame, StackFrameStepOverReason } from './smartStepping';
import { ISourceWithMap, isSourceWithWasm, IWasmLocationProvider, SourceFromMap } from './source';
import { IPreferredUiLocation } from './sourceContainer';
import { getToStringIfCustom } from './templates/getStringyProps';
import { RawLocation, Thread } from './threads';
import { IExtraProperty, IScopeRef, IVariableContainer } from './variableStore';

export interface IFrameElement {
  /** DAP stack frame ID */
  readonly frameId: number;
  /** Formats the stack element as V8 would format it */
  formatAsNative(): Promise<string>;
  /** Pretty formats the stack element as text */
  format(): Promise<string>;
  /** Formats the element for DAP */
  toDap(format?: Dap.StackFrameFormat): Promise<Dap.StackFrame>;
}

export interface IStackFrameElement extends IFrameElement {
  /** Stack frame that contains this one. Usually == this, except for inline stack frames */
  readonly root: StackFrame;

  /** UI location for the frame. */
  uiLocation(): Promise<IPreferredUiLocation | undefined> | IPreferredUiLocation | undefined;

  /**
   * Gets variable scopes on this frame. All scope variables should be added
   * to the paused {@link VariablesStore} when this resolves.
   */
  scopes(): Promise<Dap.ScopesResult>;

  /**
   * Gets ranges that should be stepped for the given step kind and location.
   */
  getStepSkipList(direction: StepDirection, position: IPosition): Promise<Range[] | undefined>;
}

type FrameElement = StackFrame | InlinedFrame | AsyncSeparator;

export const isStackFrameElement = (element: IFrameElement): element is IStackFrameElement =>
  typeof (element as IStackFrameElement).uiLocation === 'function';

export class StackTrace {
  public readonly frames: FrameElement[] = [];
  private _frameById: Map<number, StackFrame | InlinedFrame> = new Map();
  /**
   * Frame index that was last checked for inline expansion.
   * @see https://github.com/ChromeDevTools/devtools-frontend/blob/c9f204731633fd2e2b6999a2543e99b7cc489b4b/docs/language_extension_api.md#dealing-with-inlined-functions
   */
  private _lastInlineWasmExpanded = Promise.resolve(0);
  private _asyncStackTraceId?: Cdp.Runtime.StackTraceId;
  private _lastFrameThread?: Thread;

  public static fromRuntime(thread: Thread, stack: Cdp.Runtime.StackTrace): StackTrace {
    const result = new StackTrace(thread);
    for (const frame of stack.callFrames) {
      if (!frame.url.endsWith(SourceConstants.InternalExtension)) {
        result.frames.push(StackFrame.fromRuntime(thread, frame, false));
      }
    }

    if (stack.parentId) {
      result._asyncStackTraceId = stack.parentId;
      console.assert(!stack.parent);
    } else {
      result._appendStackTrace(thread, stack.parent);
    }

    return result;
  }

  public static fromDebugger(
    thread: Thread,
    frames: Cdp.Debugger.CallFrame[],
    parent?: Cdp.Runtime.StackTrace,
    parentId?: Cdp.Runtime.StackTraceId,
  ): StackTrace {
    const result = new StackTrace(thread);
    for (const callFrame of frames) {
      result._appendFrame(StackFrame.fromDebugger(thread, callFrame));
    }
    if (parentId) {
      result._asyncStackTraceId = parentId;
      console.assert(!parent);
    } else {
      result._appendStackTrace(thread, parent);
    }
    return result;
  }

  constructor(private readonly thread: Thread) {
    this._lastFrameThread = thread;
  }

  public async loadFrames(limit: number, noFuncEval?: boolean): Promise<FrameElement[]> {
    await this.expandAsyncStack(limit, noFuncEval);
    await this.expandWasmFrames();
    return this.frames;
  }

  private async expandAsyncStack(limit: number, noFuncEval?: boolean) {
    while (this.frames.length < limit && this._asyncStackTraceId) {
      if (this._asyncStackTraceId.debuggerId) {
        this._lastFrameThread = Thread.threadForDebuggerId(this._asyncStackTraceId.debuggerId);
      }

      if (!this._lastFrameThread) {
        this._asyncStackTraceId = undefined;
        break;
      }

      if (noFuncEval) {
        this._lastFrameThread
          .cdp()
          .DotnetDebugger.setEvaluationOptions({ options: { noFuncEval }, type: 'stackFrame' });
      }

      const response = await this._lastFrameThread
        .cdp()
        .Debugger.getStackTrace({ stackTraceId: this._asyncStackTraceId });
      this._asyncStackTraceId = undefined;
      if (response) {
        this._appendStackTrace(this._lastFrameThread, response.stackTrace);
      }
    }
  }

  private expandWasmFrames() {
    return (this._lastInlineWasmExpanded = this._lastInlineWasmExpanded.then(async last => {
      for (; last < this.frames.length; last++) {
        const frame = this.frames[last];
        if (!(frame instanceof StackFrame)) {
          continue;
        }

        const source = frame.scriptSource?.resolvedSource;
        if (!isSourceWithWasm(source)) {
          continue;
        }

        const symbols = await source.sourceMap.value.promise;
        if (!symbols.getFunctionStack) {
          continue;
        }

        const stack = await symbols.getFunctionStack(frame.rawPosition);
        if (stack.length === 0) {
          continue;
        }

        const newFrames: InlinedFrame[] = [];
        for (let i = 0; i < stack.length; i++) {
          const inlinedFrame = new InlinedFrame({
            source,
            thread: this.thread,
            inlineFrameIndex: i,
            name: stack[i].name,
            root: frame,
          });
          this._frameById.set(inlinedFrame.frameId, inlinedFrame);
          newFrames.push(inlinedFrame);
        }

        this._spliceFrames(last, 1, ...newFrames);
        last += stack.length - 1;
      }

      return last;
    }));
  }

  public frame(frameId: number): StackFrame | InlinedFrame | undefined {
    return this._frameById.get(frameId);
  }

  private _appendStackTrace(thread: Thread, stackTrace: Cdp.Runtime.StackTrace | undefined) {
    console.assert(!stackTrace || !this._asyncStackTraceId);

    while (stackTrace) {
      if (stackTrace.description === 'async function' && stackTrace.callFrames.length) {
        stackTrace.callFrames.shift();
      }

      if (stackTrace.callFrames.length) {
        this._appendFrame(new AsyncSeparator(stackTrace.description || 'async'));
        for (const callFrame of stackTrace.callFrames) {
          this._appendFrame(StackFrame.fromRuntime(thread, callFrame, true));
        }
      }

      if (stackTrace.parentId) {
        this._asyncStackTraceId = stackTrace.parentId;
        console.assert(!stackTrace.parent);
      }

      stackTrace = stackTrace.parent;
    }
  }

  private _spliceFrames(index: number, deleteCount: number, ...frames: FrameElement[]) {
    this.frames.splice(index, deleteCount, ...frames);
    for (const frame of frames) {
      if (!(frame instanceof AsyncSeparator)) {
        this._frameById.set(frame.frameId, frame);
      }
    }
  }

  private _appendFrame(frame: FrameElement) {
    this._spliceFrames(this.frames.length, 0, frame);
  }

  public async formatAsNative(): Promise<string> {
    return await this.formatWithMapper(frame => frame.formatAsNative());
  }

  public async format(): Promise<string> {
    return await this.formatWithMapper(frame => frame.format());
  }

  private async formatWithMapper(
    mapper: (frame: FrameElement) => Promise<string>,
  ): Promise<string> {
    let stackFrames = await this.loadFrames(50);
    // REPL may call back into itself; slice at the highest REPL eval in the call chain.
    for (let i = stackFrames.length - 1; i >= 0; i--) {
      const frame = stackFrames[i];
      if (frame instanceof StackFrame && frame.isReplEval) {
        stackFrames = stackFrames.slice(0, i + 1);
        break;
      }
    }
    const promises = stackFrames.map(mapper);
    return (await Promise.all(promises)).join('\n') + '\n';
  }

  public async toDap(params: Dap.StackTraceParamsExtended): Promise<Dap.StackTraceResult> {
    const from = params.startFrame || 0;
    let to = (params.levels || 50) + from;
    const frames = await this.loadFrames(to, params.noFuncEval);
    to = Math.min(frames.length, params.levels ? to : frames.length);

    const result: Promise<Dap.StackFrame>[] = [];
    for (let index = from; index < to; index++) {
      result.push(frames[index].toDap(params.format));
    }

    return {
      stackFrames: await Promise.all(result),
      totalFrames: !!this._asyncStackTraceId ? 1000000 : frames.length,
    };
  }
}

interface IScope {
  chain: Cdp.Debugger.Scope[];
  thisObject: Cdp.Runtime.RemoteObject;
  returnValue?: Cdp.Runtime.RemoteObject;
  variables: (IVariableContainer | undefined)[];
  callFrameId: string;
}

const frameIdCounter = posInt32Counter();

export class AsyncSeparator implements IFrameElement {
  public readonly frameId = frameIdCounter();

  constructor(private readonly label = 'async') {}

  public async toDap(): Promise<Dap.StackFrame> {
    return { name: this.label, id: 0, line: 0, column: 0, presentationHint: 'label' };
  }

  public async formatAsNative(): Promise<string> {
    return `    --- ${this.label} ---`;
  }

  public async format(): Promise<string> {
    return `◀ ${this.label} ▶`;
  }
}

const fallbackName = '<anonymous>';
const CLASS_CTOR_RE = /^class\s+(.+) {($|\n)/;

async function getEnhancedName(
  thread: Thread,
  callFrame: Cdp.Debugger.CallFrame,
  useCustomName: boolean,
) {
  if (!callFrame.functionName) {
    // 1. if there's no function name, this cannot be a method. Top-level code in
    //    a .js file will have a generic "object" scope but no name, so this avoids
    //    misrepresenting it.
    return fallbackName;
  }

  if (callFrame.functionName.includes('.')) {
    // 2. Some object names are formatted nicely and already contain a method
    //    access, so skip formatting those.
    return callFrame.functionName;
  }

  let objName: string | undefined;
  if (callFrame.this.objectId && useCustomName) {
    const ret = await thread.cdp().Runtime.callFunctionOn({
      functionDeclaration: getToStringIfCustom.decl('64', 'null'),
      objectId: callFrame.this.objectId,
      returnByValue: true,
    });
    objName = ret?.result.value;
  }

  if (!objName && callFrame.this.description) {
    objName = callFrame.this.description;

    // Static methods `this` is described like `class Foo {` -- make that just `Foo`
    const classCtor = CLASS_CTOR_RE.exec(objName);
    if (classCtor) {
      objName = classCtor[1];
    }
  }
  if (!objName) {
    return callFrame.functionName;
  }

  const idx = objName.indexOf('\n');
  if (idx !== -1) {
    objName = objName.slice(0, idx).trim();
  }

  const fnName = callFrame.functionName;
  if (objName === fnName) {
    return `${objName}.constructor`;
  }

  return objName ? `${objName}.${fnName}` : fnName;
}

function getDefaultName(callFrame: Cdp.Debugger.CallFrame | Cdp.Runtime.CallFrame) {
  return callFrame.functionName || fallbackName;
}

export class StackFrame implements IStackFrameElement {
  public readonly frameId = frameIdCounter();
  /** Override for the `name` in the DAP representation. */
  public overrideName?: string;
  /** @inheritdoc */
  public readonly root = this;

  private _rawLocation: RawLocation;

  /** @inheritdoc */
  public readonly uiLocation: () =>
    | Promise<IPreferredUiLocation | undefined>
    | IPreferredUiLocation
    | undefined;
  private _scope: IScope | undefined;
  private _thread: Thread;
  public readonly isReplEval: boolean;

  public get rawPosition() {
    // todo: move RawLocation to use Positions, then just return that.
    return new Base1Position(this._rawLocation.lineNumber, this._rawLocation.columnNumber);
  }

  /** Raw chain from the runtime, applicable only to debug-triggered traces */
  public get rawScopeChain() {
    return this._scope?.chain || [];
  }

  static fromRuntime(
    thread: Thread,
    callFrame: Cdp.Runtime.CallFrame,
    isAsync: boolean,
  ): StackFrame {
    return new StackFrame(thread, callFrame, thread.rawLocation(callFrame), isAsync);
  }

  static fromDebugger(thread: Thread, callFrame: Cdp.Debugger.CallFrame): StackFrame {
    const result = new StackFrame(thread, callFrame, thread.rawLocation(callFrame));
    result._scope = {
      chain: callFrame.scopeChain,
      thisObject: callFrame.this,
      returnValue: callFrame.returnValue,
      variables: new Array(callFrame.scopeChain.length).fill(undefined),
      // eslint-disable-next-line
      callFrameId: callFrame.callFrameId!,
    };
    return result;
  }

  constructor(
    thread: Thread,
    private readonly callFrame: Cdp.Debugger.CallFrame | Cdp.Runtime.CallFrame,
    rawLocation: RawLocation,
    private readonly isAsync = false,
  ) {
    this._rawLocation = rawLocation;
    this.uiLocation = once(() => thread.rawLocationToUiLocation(rawLocation));
    this._thread = thread;
    const script = rawLocation.scriptId ? thread.getScriptById(rawLocation.scriptId) : undefined;
    this.isReplEval = script ? script.url.endsWith(SourceConstants.ReplExtension) : false;
  }

  /**
   * Gets this frame's script ID.
   */
  public get scriptId() {
    return 'scriptId' in this.callFrame
      ? this.callFrame.scriptId
      : this.callFrame.location.scriptId;
  }

  /**
   * Gets the source associated with the script ID of the stackframe. This may
   * not be where the frame is eventually displayed to the user;
   * use {@link uiLocation} for that.
   */
  public get scriptSource() {
    return this._thread._sourceContainer.getScriptById(this.scriptId);
  }

  /**
   * Gets whether the runtime explicitly said this frame can be restarted.
   */
  public get canExplicitlyBeRestarted() {
    return !!(this.callFrame as Cdp.Debugger.CallFrame).canBeRestarted;
  }

  /**
   * Gets whether this stackframe is at the same position as the other frame.
   */
  public equivalentTo(other: unknown) {
    return (
      other instanceof StackFrame
      && other._rawLocation.columnNumber === this._rawLocation.columnNumber
      && other._rawLocation.lineNumber === this._rawLocation.lineNumber
      && other._rawLocation.scriptId === this._rawLocation.scriptId
    );
  }

  callFrameId(): string | undefined {
    return this._scope ? this._scope.callFrameId : undefined;
  }

  /** @inheritdoc */
  async scopes(): Promise<Dap.ScopesResult> {
    const currentScope = this._scope;
    if (!currentScope) {
      throw new ProtocolError(asyncScopesNotAvailable());
    }

    const scopes = await Promise.all(
      currentScope.chain.map(async (scope, scopeNumber) => {
        let name = '';
        let presentationHint: 'arguments' | 'locals' | 'registers' | undefined;
        switch (scope.type) {
          case 'global':
            name = l10n.t('Global');
            break;
          case 'local':
            name = l10n.t('Local');
            presentationHint = 'locals';
            break;
          case 'with':
            name = l10n.t('With Block');
            presentationHint = 'locals';
            break;
          case 'closure':
            name = l10n.t('Closure');
            presentationHint = 'arguments';
            break;
          case 'catch':
            name = l10n.t('Catch Block');
            presentationHint = 'locals';
            break;
          case 'block':
            name = l10n.t('Block');
            presentationHint = 'locals';
            break;
          case 'script':
            name = l10n.t('Script');
            break;
          case 'eval':
            name = l10n.t('Eval');
            break;
          case 'module':
            name = l10n.t('Module');
            break;
          default:
            // fallback for custom scope types from other runtimes (#651)
            name = scope.type.substr(0, 1).toUpperCase() + scope.type.substr(1);
            break;
        }
        if (scope.name && scope.type === 'closure') {
          name = l10n.t('Closure ({0})', scope.name);
        } else if (scope.name) {
          name = `${name}: ${scope.name}`;
        }

        const variable = this._scopeVariable(scopeNumber, currentScope);
        if (!variable) {
          return undefined;
        }

        const dap: Dap.Scope = {
          name,
          presentationHint,
          expensive: scope.type === 'global',
          variablesReference: variable.id,
        };
        if (scope.startLocation) {
          const startRawLocation = this._thread.rawLocation(scope.startLocation);
          const startUiLocation = await this._thread.rawLocationToUiLocation(startRawLocation);
          dap.line = (startUiLocation || startRawLocation).lineNumber;
          dap.column = (startUiLocation || startRawLocation).columnNumber;
          if (startUiLocation) dap.source = await startUiLocation.source.toDap();
          if (scope.endLocation) {
            const endRawLocation = this._thread.rawLocation(scope.endLocation);
            const endUiLocation = await this._thread.rawLocationToUiLocation(endRawLocation);
            dap.endLine = (endUiLocation || endRawLocation).lineNumber;
            dap.endColumn = (endUiLocation || endRawLocation).columnNumber;
          }
        }
        return dap;
      }),
    );

    return { scopes: scopes.filter(truthy) };
  }

  /** @inheritdoc */
  public getStepSkipList(_direction: StepDirection): Promise<Range[] | undefined> {
    // Normal JS never has any skip lists -- only web assembly does
    return Promise.resolve(undefined);
  }

  private readonly getLocationInfo = once(async () => {
    const uiLocation = this.uiLocation();
    const isSmartStepped = await shouldStepOverStackFrame(this);
    // only use the relatively expensive custom tostring lookup for frames
    // that aren't skipped, to avoid unnecessary work e.g. on node_internals
    const name = this.overrideName
      || ('this' in this.callFrame
        ? await getEnhancedName(
          this._thread,
          this.callFrame,
          isSmartStepped === StackFrameStepOverReason.NotStepped,
        )
        : getDefaultName(this.callFrame));

    return { isSmartStepped, name, uiLocation: await uiLocation };
  });

  /** @inheritdoc */
  async toDap(format?: Dap.StackFrameFormat): Promise<Dap.StackFrame> {
    const { isSmartStepped, name, uiLocation } = await this.getLocationInfo();
    const source = uiLocation ? await uiLocation.source.toDap() : undefined;
    const presentationHint = isSmartStepped ? 'deemphasize' : 'normal';
    if (isSmartStepped && source) {
      source.origin = isSmartStepped === StackFrameStepOverReason.SmartStep
        ? l10n.t('Skipped by smartStep')
        : l10n.t('Skipped by skipFiles');
    }

    const line = (uiLocation || this._rawLocation).lineNumber;
    const column = (uiLocation || this._rawLocation).columnNumber;

    let formattedName = name;

    if (source && format) {
      if (format.module) {
        formattedName += ` [${source.name}]`;
      }

      if (format.line) {
        formattedName += ` Line ${line}`;
      }
    }

    return {
      id: this.frameId,
      name: formattedName, // TODO: Use params to format the name
      line,
      column,
      source,
      presentationHint,
      // If `canBeRestarted` is present, use that
      // https://github.com/microsoft/vscode-js-debug/issues/1283
      canRestart: (this.callFrame as Cdp.Debugger.CallFrame).canBeRestarted ?? !this.isAsync,
    } as Dap.StackFrame;
  }

  /** @inheritdoc */
  async formatAsNative(): Promise<string> {
    const { name, uiLocation } = await this.getLocationInfo();
    const url = (await uiLocation?.source.existingAbsolutePath())
      || (await uiLocation?.source.prettyName())
      || this.callFrame.url;
    const { lineNumber, columnNumber } = uiLocation || this._rawLocation;
    return `    at ${name} (${url}:${lineNumber}:${columnNumber})`;
  }

  /** @inheritdoc */
  async format(): Promise<string> {
    const { name, uiLocation } = await this.getLocationInfo();
    const prettyName = (await uiLocation?.source.prettyName()) || '<unknown>';
    const anyLocation = uiLocation || this._rawLocation;
    let text = `${name} @ ${prettyName}:${anyLocation.lineNumber}`;
    if (anyLocation.columnNumber > 1) text += `:${anyLocation.columnNumber}`;
    return text;
  }

  /** Gets the variable container for a scope. Returns undefined if the thread is not longer paused. */
  private _scopeVariable(scopeNumber: number, scope: IScope): IVariableContainer | undefined {
    const existing = scope.variables[scopeNumber];
    if (existing) {
      return existing;
    }

    const scopeRef: IScopeRef = {
      stackFrame: this,
      callFrameId: scope.callFrameId,
      scopeNumber,
    };

    const extraProperties: IExtraProperty[] = [];
    if (scopeNumber === 0) {
      if (scope.thisObject) extraProperties.push({ name: 'this', value: scope.thisObject });
      if (scope.returnValue) {
        extraProperties.push({
          name: l10n.t('Return value'),
          value: scope.returnValue,
        });
      }
    }

    const paused = this._thread.pausedVariables();
    if (!paused) {
      return undefined;
    }

    const variable = paused.createScope(
      scope.chain[scopeNumber].object,
      scopeRef,
      extraProperties,
    );
    return (scope.variables[scopeNumber] = variable);
  }

  public readonly completions = once(async (): Promise<Dap.CompletionItem[]> => {
    if (!this._scope) return [];
    const variableStore = this._thread.pausedVariables();
    if (!variableStore) {
      return [];
    }

    const promises: Promise<Dap.CompletionItem[]>[] = [];
    for (let scopeNumber = 0; scopeNumber < this._scope.chain.length; scopeNumber++) {
      const scopeVariable = this._scopeVariable(scopeNumber, this._scope);
      if (!scopeVariable) {
        continue;
      }

      promises.push(
        variableStore
          .getVariableNames({
            variablesReference: scopeVariable.id,
          })
          .then(variables => variables.map(({ name }) => ({ label: name, type: 'property' }))),
      );
    }
    const completions = await Promise.all(promises);
    return ([] as Dap.CompletionItem[]).concat(...completions);
  });
}

const EMPTY_SCOPES: Dap.ScopesResult = { scopes: [] };

export class InlinedFrame implements IStackFrameElement {
  /** @inheritdoc */
  public readonly root: StackFrame;

  /** @inheritdoc */
  public readonly frameId = frameIdCounter();

  /** @inheritdoc */
  public readonly uiLocation: () => Promise<IPreferredUiLocation>;

  public readonly inlineFrameIndex: number;

  private readonly wasmPosition: Base0Position;
  private readonly name: string;
  private readonly thread: Thread;
  private readonly source: ISourceWithMap<IWasmLocationProvider>;

  constructor(opts: {
    thread: Thread;
    /** Inline frame index in the function info */
    inlineFrameIndex: number;
    /** Display name of the call frame */
    name: string;
    /** Original WASM source */
    source: ISourceWithMap<IWasmLocationProvider>;
    /** Original stack frame this was derived from */
    root: StackFrame;
  }) {
    this.name = opts.name;
    this.root = opts.root;
    this.thread = opts.thread;
    this.source = opts.source;
    this.inlineFrameIndex = opts.inlineFrameIndex;
    this.wasmPosition = new Base0Position(
      this.inlineFrameIndex,
      this.root.rawPosition.base0.columnNumber,
    );
    this.uiLocation = once(() =>
      opts.thread._sourceContainer.preferredUiLocation({
        columnNumber: opts.root.rawPosition.base1.columnNumber,
        lineNumber: opts.inlineFrameIndex + 1,
        source: opts.source,
      })
    );
  }

  /** @inheritdoc */
  public async formatAsNative(): Promise<string> {
    const { columnNumber, lineNumber, source } = await this.uiLocation();
    return `    at ${this.name} (${source.url}:${lineNumber}:${columnNumber})`;
  }

  /** @inheritdoc */
  public async format(): Promise<string> {
    const { columnNumber, lineNumber, source } = await this.uiLocation();
    const prettyName = (await source.prettyName()) || '<unknown>';
    return `${this.name} @ ${prettyName}:${lineNumber}:${columnNumber}`;
  }

  /** @inheritdoc */
  public async toDap(): Promise<Dap.StackFrame> {
    const { columnNumber, lineNumber, source } = await this.uiLocation();
    return Promise.resolve({
      id: this.frameId,
      name: this.name,
      column: columnNumber,
      line: lineNumber,
      source: await source.toDap(),
    });
  }

  /** @inheritdoc */
  public async getStepSkipList(direction: StepDirection): Promise<Range[] | undefined> {
    const sm = this.source.sourceMap.value.settledValue;
    if (!sm?.getStepSkipList) {
      return;
    }

    const uiLocation = await this.uiLocation();
    if (uiLocation) {
      return sm.getStepSkipList(
        direction,
        this.wasmPosition,
        (uiLocation.source as SourceFromMap).compiledToSourceUrl.get(this.source),
        new Base1Position(uiLocation.lineNumber, uiLocation.columnNumber),
      );
    } else {
      return sm.getStepSkipList(direction, this.root.rawPosition);
    }
  }

  /** @inheritdoc */
  public async scopes(): Promise<Dap.ScopesResult> {
    const v = this.source.sourceMap.value.settledValue;
    const callFrameId = this.root.callFrameId();
    if (!v || !callFrameId) {
      return EMPTY_SCOPES;
    }

    const variables = await v.getVariablesInScope?.(callFrameId, this.wasmPosition);
    if (!variables) {
      return EMPTY_SCOPES;
    }

    const paused = this.thread.pausedVariables();
    if (!paused) {
      return EMPTY_SCOPES;
    }

    const scopeRef: IScopeRef = {
      stackFrame: this.root,
      callFrameId,
      scopeNumber: 0, // this is only used for setting variables, which wasm doesn't support
    };

    return {
      scopes: await Promise.all(
        [...groupBy(variables, v => v.scope)].map(([key, vars]) =>
          paused
            .createWasmScope(key as WasmScope, vars, scopeRef)
            .toDap(PreviewContextType.PropertyValue)
            .then(v => ({
              name: v.name,
              variablesReference: v.variablesReference,
              expensive: key !== WasmScope.Local,
            }))
        ),
      ),
    };
  }
}
