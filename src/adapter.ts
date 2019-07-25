import * as DAP from './dap';
import * as CDP from './connection';
import {DebugProtocol} from 'vscode-debugprotocol';
import Protocol from 'devtools-protocol';

import {Target, TargetManager, TargetEvents} from './targetManager';
import {findChrome} from './findChrome';
import * as launcher from './launcher';
import {Script, Thread, ThreadEvents} from './thread';

export class Adapter implements DAP.Adapter {
  private _dap: DAP.Connection;
  private _cdp: CDP.Connection;
  private _targetManager: TargetManager;
  private _launchParams: DAP.LaunchParams;

  private _mainTarget: Target;
  private _threads: Map<number, Thread> = new Map();
  private _scripts: Map<number, Script> = new Map();
  private _lastVariableReference: number = 0;
  private _variableToObject: Map<number, Protocol.Runtime.RemoteObject> = new Map();
  private _objectToVariable: Map<Protocol.Runtime.RemoteObjectId, number> = new Map();

  constructor(dap: DAP.Connection) {
    this._dap = dap;
    dap.setAdapter(this);
  }

  public async initialize(params: DebugProtocol.InitializeRequestArguments): Promise<DebugProtocol.Capabilities> {
    console.assert(params.linesStartAt1);
    console.assert(params.columnsStartAt1);
    console.assert(params.pathFormat === 'path');

    const executablePath = findChrome().pop();
    this._cdp = await launcher.launch(
      executablePath, {
        userDataDir: '.profile',
        pipe: true,
      });

    this._targetManager = new TargetManager(this._cdp);
    this._targetManager.on(TargetEvents.TargetAttached, (target: Target) => {
      if (target.thread())
        this._onThreadCreated(target.thread());
    });
    this._targetManager.on(TargetEvents.TargetDetached, (target: Target) => {
      if (target.thread())
        this._onThreadDestroyed(target.thread());
    });

    this._cdp.browserSession().on(CDP.SessionEvents.Disconnected, () => this._dap.didExit(0));

    // params.locale || 'en-US'
    // params.supportsVariableType
    // params.supportsVariablePaging
    // params.supportsRunInTerminalRequest
    // params.supportsMemoryReferences

    this._dap.didInitialize();
    return {
      supportsConfigurationDoneRequest: false,
      supportsFunctionBreakpoints: false,
      supportsConditionalBreakpoints: false,
      supportsHitConditionalBreakpoints: false,
      supportsEvaluateForHovers: false,
      exceptionBreakpointFilters: [],
      supportsStepBack: false,
      supportsSetVariable: false,
      supportsRestartFrame: false,
      supportsGotoTargetsRequest: false,
      supportsStepInTargetsRequest: false,
      supportsCompletionsRequest: true,
      supportsModulesRequest: false,
      additionalModuleColumns: [],
      supportedChecksumAlgorithms: [],
      supportsRestartRequest: true,
      supportsExceptionOptions: false,
      supportsValueFormattingOptions: false,
      supportsExceptionInfoRequest: false,
      supportTerminateDebuggee: false,
      supportsDelayedStackTraceLoading: false,
      supportsLoadedSourcesRequest: true,
      supportsLogPoints: false,
      supportsTerminateThreadsRequest: false,
      supportsSetExpression: false,
      supportsTerminateRequest: false,
      //supportsDataBreakpoints: false,
      //supportsReadMemoryRequest: false,
      //supportsDisassembleRequest: false,
    };
  }

  _onThreadCreated(thread: Thread): void {
    console.assert(!this._threads.has(thread.threadId()));
    this._threads.set(thread.threadId(), thread);
    this._dap.didChangeThread('started', thread.threadId());

    const onPaused = () => {
      const details = thread.pausedDetails();
      this._dap.didPause({
        reason: details.reason,
        description: 'didPause.description',
        threadId: thread.threadId(),
        text: 'didPause.text'
      });
    };
    thread.on(ThreadEvents.ThreadPaused, onPaused);
    if (thread.pausedDetails())
      onPaused();

    thread.on(ThreadEvents.ThreadResumed, () => {
      this._dap.didResume(thread.threadId());
    });

    const onScriptParsed = (script: Script) => {
      this._scripts.set(script.sourceReference(), script);
      this._dap.didChangeScript('new', script.toDap());
    };
    thread.on(ThreadEvents.ScriptAdded, onScriptParsed);
    for (const [scriptId, script] of thread.scripts())
      onScriptParsed(script);
    thread.on(ThreadEvents.ScriptsRemoved, (scripts: Script[]) => {
      for (const script of scripts)
        this._dap.didChangeScript('removed', script.toDap());
    });
  }

  _onThreadDestroyed(thread: Thread): void {
    this._threads.delete(thread.threadId());
    this._dap.didChangeThread('exited', thread.threadId());
  }

  async launch(params: DAP.LaunchParams): Promise<void> {
    // params.noDebug
    this._launchParams = params;
    this._mainTarget = this._targetManager.mainTarget();
    if (!this._mainTarget)
      this._mainTarget = await new Promise(f => this._targetManager.once(TargetEvents.TargetAttached, f));
    this._targetManager.on(TargetEvents.TargetDetached, (target: Target) => {
      if (target === this._mainTarget) {
        this._dap.didTerminate();
      }
    });
    await this._load();
  }

  async terminate(params: DebugProtocol.TerminateArguments): Promise<void> {
  }

  async disconnect(params: DebugProtocol.DisconnectArguments): Promise<void> {
    this._cdp.browserSession().send('Browser.close');
  }

  async _load(): Promise<void> {
    if (this._mainTarget && this._launchParams) {
      await this._mainTarget.session().send('Page.navigate', {url: this._launchParams.url});
    }
  }

  async restart(params: DebugProtocol.RestartArguments): Promise<void> {
    this._load();
  }

  async getThreads(): Promise<DebugProtocol.Thread[]> {
    const result = [];
    for (const thread of this._threads.values())
      result.push(thread.toDap());
    return result;
  }

  async continue(params: DebugProtocol.ContinueArguments): Promise<void> {
    const thread = this._threads.get(params.threadId);
    if (thread)
      thread.resume();
  }

  async getStackTrace(params: DebugProtocol.StackTraceArguments): Promise<DAP.StackTraceResult> {
    return {stackFrames: [], totalFrames: 0};
  }

  async getScopes(params: DebugProtocol.ScopesArguments): Promise<DebugProtocol.Scope[]> {
    return [];
  }

  async getVariables(params: DebugProtocol.VariablesArguments): Promise<DebugProtocol.Variable[]> {
    const object = this._variableToObject.get(params.variablesReference);
    if (object.subtype === 'array') {
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

  async _getObjectProperties(object: Protocol.Runtime.RemoteObject): Promise<DebugProtocol.Variable[]> {
    const getPropertiesParams: Protocol.Runtime.GetPropertiesRequest = {
      objectId: object.objectId,
      ownProperties: true
    };
    const response = await this._mainTarget.session().send('Runtime.getProperties', getPropertiesParams) as Protocol.Runtime.GetPropertiesResponse;
    const properties = response.result;
    return Promise.all(properties.map(p => this._createVariable(p.name, p.value)));
  }

  async _getArrayProperties(params: DebugProtocol.VariablesArguments, object: Protocol.Runtime.RemoteObject): Promise<DebugProtocol.Variable[]> {
    const callParams: Protocol.Runtime.CallFunctionOnRequest = {
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
        }`,
    };
    const response = await this._mainTarget.session().send('Runtime.callFunctionOn', callParams) as Protocol.Runtime.CallFunctionOnResponse;
    return this._getObjectProperties(response.result);
  }

  async _getArraySlots(params: DebugProtocol.VariablesArguments, object: Protocol.Runtime.RemoteObject): Promise<DebugProtocol.Variable[]> {
    const callParams: Protocol.Runtime.CallFunctionOnRequest = {
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
      arguments: [ { value: params.start }, { value: params.count } ]
    };
    const response = await this._mainTarget.session().send('Runtime.callFunctionOn', callParams) as Protocol.Runtime.CallFunctionOnResponse;
    const result = (await this._getObjectProperties(response.result)).filter(p => p.name !== '__proto__');
    return result;
  }

  _createVariableReference(object: Protocol.Runtime.RemoteObject): number {
    const reference = ++this._lastVariableReference;
    this._variableToObject.set(reference, object);
    this._objectToVariable.set(object.objectId, reference);
    return reference;
  }

  async _createVariable(name: string, value: Protocol.Runtime.RemoteObject): Promise<DebugProtocol.Variable> {
    if (!value) {
      // TODO(pfeldman): implement getters / setters
      return {
        name,
        value: '',
        variablesReference: 0
      };
    }

    if (value.subtype === 'array')
      return this._createArrayVariable(name, value);
    if (value.objectId)
      return this._createObjectVariable(name, value);
    return this._createPrimitiveVariable(name, value);
  }

  async _createPrimitiveVariable(name: string, value: Protocol.Runtime.RemoteObject): Promise<DebugProtocol.Variable> {
    return {
      name,
      value: value.unserializableValue || value.value,
      type: value.type,
      variablesReference: 0
    };
  }

  async _createObjectVariable(name: string, value: Protocol.Runtime.RemoteObject): Promise<DebugProtocol.Variable> {
    const variablesReference = this._createVariableReference(value);
    return {
      name,
      value: value.description,
      type: value.className || value.subtype || value.type,
      variablesReference
    };
  }

  async _createArrayVariable(name: string, value: Protocol.Runtime.RemoteObject): Promise<DebugProtocol.Variable> {
    const variablesReference = this._createVariableReference(value);
    const callParams: Protocol.Runtime.CallFunctionOnRequest = {
      objectId: value.objectId,
      functionDeclaration: `function (prefix) {
          return this.length;
        }`,
      objectGroup: 'console',
      returnByValue: true
    };

    const response = await this._mainTarget.session().send('Runtime.callFunctionOn', callParams) as Protocol.Runtime.CallFunctionOnResponse;
    const indexedVariables = response.result.value;

    return {
      name,
      value: value.description,
      type: value.className || value.subtype || value.type,
      variablesReference,
      indexedVariables
    };
  }

  async evaluate(args: DebugProtocol.EvaluateArguments): Promise<DAP.EvaluateResult> {
    if (!this._mainTarget)
      return {result: '', variablesReference: 0};
    const evaluateParams: Protocol.Runtime.EvaluateRequest = {
      expression: args.expression,
      includeCommandLineAPI: true,
      objectGroup: 'console'
    };
    const response = await this._mainTarget.session().send('Runtime.evaluate', evaluateParams) as Protocol.Runtime.EvaluateResponse;
    if (response.result.objectId) {
      const variable = await this._createVariable('', response.result);
      return {
        result: response.result.description,
        variablesReference: variable.variablesReference,
        namedVariables: variable.namedVariables,
        indexedVariables: variable.indexedVariables,
      };
    }
    return {result: response.result.description, variablesReference: 0};
  }

  async completions(params: DebugProtocol.CompletionsArguments): Promise<DAP.CompletionsResult> {
    if (!this._mainTarget)
      return {targets: []};
    const global = await this._mainTarget.session().send('Runtime.evaluate', {expression: 'self'}) as Protocol.Runtime.EvaluateResponse;
    if (!global)
      return {targets: []};

    const callArg: Protocol.Runtime.CallArgument = {
      value: params.text
    };
    const callParams: Protocol.Runtime.CallFunctionOnRequest = {
      objectId: global.result.objectId,
      functionDeclaration: `function (prefix) {
          return Object.getOwnPropertyNames(this).filter(l => l.startsWith(prefix));
        }`,
      objectGroup: 'console',
      arguments: [callArg],
      returnByValue: true
    };
    const response = await this._mainTarget.session().send('Runtime.callFunctionOn', callParams) as Protocol.Runtime.CallFunctionOnResponse;
    if (!response)
      return {targets: []};

    const completions = response.result.value as string[];
    return {
      targets: completions.map(label => {
        return {label};
      })
    };
  }

  async getScripts(params: DebugProtocol.LoadedSourcesArguments): Promise<DebugProtocol.Source[]> {
    const sources = [];
    for (const [threadId, thread] of this._threads) {
      for (const [scriptId, script] of thread.scripts())
        sources.push(script.toDap());
    }
    return sources;
  }

  async getScriptSource(params: DebugProtocol.SourceArguments): Promise<DAP.GetScriptSourceResult> {
    const script = this._scripts.get(params.sourceReference);
    if (!script)
      return {content: '', mimeType: 'text/javascript'};
    return {content: await script.source(), mimeType: 'text/javascript'};
  }
}
