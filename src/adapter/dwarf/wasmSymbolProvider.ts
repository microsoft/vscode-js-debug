/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import type { IWasmWorker, MethodReturn } from '@vscode/dwarf-debugging';
import { Chrome } from '@vscode/dwarf-debugging/chrome-cxx/mnt/extension-api';
import { randomUUID } from 'crypto';
import { inject, injectable } from 'inversify';
import Cdp from '../../cdp/api';
import { ICdpApi } from '../../cdp/connection';
import { binarySearch } from '../../common/arrayUtils';
import { IDisposable } from '../../common/disposable';
import { ILogger, LogTag } from '../../common/logging';
import { flatten, once } from '../../common/objUtils';
import { Base0Position, IPosition, Range } from '../../common/positions';
import { AnyLaunchConfiguration } from '../../configuration';
import * as errors from '../../dap/errors';
import { ProtocolError } from '../../dap/protocolError';
import { StepDirection } from '../pause';
import { getSourceSuffix } from '../templates';
import { IDwarfModuleProvider } from './dwarfModuleProvider';

export const IWasmSymbolProvider = Symbol('IWasmSymbolProvider');

export interface IWasmSymbolProvider {
  /** Loads WebAssembly symbols for the given wasm script, returning symbol information if it exists. */
  loadWasmSymbols(script: Cdp.Debugger.ScriptParsedEvent): Promise<IWasmSymbols>;
}

export interface IWasmWorkerExt extends IWasmWorker {
  getStopId(id: string): string;
}

export const IWasmWorkerFactory = Symbol('IWasmWorkerFactory');

/** Global factory that creates wasm workers for each session. */
export interface IWasmWorkerFactory extends IDisposable {
  /**
   * Gets a handle to a wasm worker for the given session.
   */
  spawn(cdp: Cdp.Api): Promise<IWasmWorkerExt | null>;

  /**
   * Corresponds to {@link IDwarfModuleProvider.prompt}
   */
  prompt(): void;
}

export const ensureWATExtension = (path: string) => path.replace(/\.wasm$/i, '') + '.wat';

@injectable()
export class WasmWorkerFactory implements IWasmWorkerFactory {
  private cdpCounter = 0;
  private worker?: Promise<IWasmWorker | null>;

  private readonly cdp = new Map<number, Cdp.Api>();

  constructor(
    @inject(IDwarfModuleProvider) private readonly dwarf: IDwarfModuleProvider,
    @inject(AnyLaunchConfiguration) private readonly launchConfig: AnyLaunchConfiguration,
  ) {}

  /** @inheritdoc */
  public readonly prompt = once(() => this.dwarf.prompt());

  /** @inheritdoc */
  public async spawn(cdp: Cdp.Api): Promise<IWasmWorkerExt | null> {
    if (!this.launchConfig.enableDWARF) {
      return null;
    }

    this.worker ??= this.dwarf.load().then(dwarf => {
      if (!dwarf) {
        return null;
      }

      const worker = dwarf.spawn({
        getWasmGlobal: (index, stopId) => this.loadWasmValue(`globals[${index}]`, stopId),
        getWasmLocal: (index, stopId) => this.loadWasmValue(`locals[${index}]`, stopId),
        getWasmOp: (index, stopId) => this.loadWasmValue(`stack[${index}]`, stopId),
        getWasmLinearMemory: (offset, length, stopId) =>
          this.loadWasmValue(
            `[].slice.call(new Uint8Array(memories[0].buffer, ${+offset}, ${+length}))`,
            stopId,
          ).then((v: number[]) => new Uint8Array(v).buffer),
      });

      worker.rpc.sendMessage('hello', [], false);

      return worker;
    });

    const worker = await this.worker;
    if (!worker) {
      return null;
    }

    const cdpId = this.cdpCounter++;
    this.cdp.set(cdpId, cdp);

    return {
      rpc: worker.rpc,
      getStopId: id => `${cdpId}:${id}`,
      dispose: () => {
        this.cdp.delete(cdpId);
        return worker.dispose();
      },
    };
  }

  /** @inheritdoc */
  public async dispose() {
    await this.worker?.then(w => w?.dispose());
    this.worker = Promise.resolve(null);
  }

  private async loadWasmValue(expression: string, stopId: unknown) {
    const cast = stopId as string;
    const idx = cast.indexOf(':');

    const cdpId = cast.substring(0, idx);
    const callFrameId = cast.substring(idx + 1);

    const result = await this.cdp.get(+cdpId)?.Debugger.evaluateOnCallFrame({
      callFrameId,
      expression: expression + getSourceSuffix(),
      silent: true,
      returnByValue: true,
      throwOnSideEffect: true,
    });

    if (!result || result.exceptionDetails) {
      throw new Error(`evaluate failed: ${result?.exceptionDetails?.text || 'unknown'}`);
    }

    return result.result.value;
  }
}

@injectable()
export class WasmSymbolProvider implements IWasmSymbolProvider, IDisposable {
  /** Running worker, `null` signals that the dwarf module was not available */
  private readonly worker = once(() => this.dwarf.spawn(this.cdp));

  constructor(
    @inject(IWasmWorkerFactory) private readonly dwarf: IWasmWorkerFactory,
    @inject(ICdpApi) private readonly cdp: Cdp.Api,
    @inject(ILogger) private readonly logger: ILogger,
    @inject(AnyLaunchConfiguration) private readonly launchConfig: AnyLaunchConfiguration,
  ) {}

  public async loadWasmSymbols(script: Cdp.Debugger.ScriptParsedEvent): Promise<IWasmSymbols> {
    if (!this.launchConfig.enableDWARF) {
      return this.defaultSymbols(script);
    }

    const worker = await this.worker();
    if (!worker) {
      const syms = this.defaultSymbols(script);
      // disassembly is a good signal for a prompt, since that means a user
      // will have stepped into and be looking at webassembly code.
      syms.onDidDisassemble = this.dwarf.prompt;
      return syms;
    }

    const { rpc } = worker;
    const moduleId = randomUUID();

    let symbolsUrl: URL | undefined;
    try {
      symbolsUrl = script.debugSymbols?.externalURL
        ? new URL(script.debugSymbols?.externalURL)
        : undefined;
    } catch {
      // ignored
    }

    // Do the same ipv4/ipv6 attempts as we do in the IResourceProvider, but
    // fetching is handled internally by the wasm module, so we manually
    // attempt both loopbacks, which is a little less nice.
    const scriptUrl = new URL(script.url);
    const attemptHostname = scriptUrl.hostname === 'localhost'
      ? ['127.0.0.1', '[::1]', 'localhost']
      : [scriptUrl.hostname];
    const symbolsAreLocalhostToo = symbolsUrl?.hostname === 'localhost';

    let result: MethodReturn<'addRawModule'> | undefined;
    for (const hostname of attemptHostname) {
      scriptUrl.hostname = hostname;
      if (symbolsUrl && symbolsAreLocalhostToo) {
        symbolsUrl.hostname = hostname;
      }

      try {
        result = await rpc.sendMessage('addRawModule', moduleId, symbolsUrl?.toString(), {
          url: scriptUrl.toString(),
          code: !symbolsUrl && scriptUrl.protocol.startsWith('wasm:')
            ? await this.getBytecode(script.scriptId)
            : undefined,
        });
        break;
      } catch (e) {
        this.logger.warn(LogTag.SourceMapParsing, `failed to load wasm symbols for ${scriptUrl}`, {
          error: e,
        });
        // ignored
      }
    }

    if (!result) {
      return this.defaultSymbols(script);
    }

    if (!(result instanceof Array) || result.length === 0) {
      rpc.sendMessage('removeRawModule', moduleId); // no await necessary
      return this.defaultSymbols(script);
    }

    this.logger.info(LogTag.SourceMapParsing, 'parsed files from wasm', { files: result });

    return new WasmSymbols(script, this.cdp, moduleId, worker, result);
  }

  /** @inheritdoc */
  public async dispose() {
    await this.worker.value?.then(w => w?.dispose());
  }

  private defaultSymbols(script: Cdp.Debugger.ScriptParsedEvent) {
    return new DecompiledWasmSymbols(script, this.cdp, []);
  }

  private async getBytecode(scriptId: string) {
    const source = await this.cdp.Debugger.getScriptSource({ scriptId });
    const bytecode = source?.bytecode;
    return bytecode ? Buffer.from(bytecode, 'base64').buffer : undefined;
  }
}

export interface IWasmVariableEvaluation {
  type: string;
  description: string | undefined;
  linearMemoryAddress?: number;
  linearMemorySize?: number;
  getChildren?: () => Promise<{ name: string; value: IWasmVariableEvaluation }[]>;
}

export const enum WasmScope {
  Local = 'LOCAL',
  Global = 'GLOBAL',
  Parameter = 'PARAMETER',
}

export interface IWasmVariable {
  scope: WasmScope;
  name: string;
  type: string;
  evaluate: () => Promise<IWasmVariableEvaluation>;
}

export interface IWasmSymbols extends IDisposable {
  /**
   * URL in `files` that refers to the dissembled version of the WASM. This
   * is used as a fallback for locations that don't better map to a known symbol.
   */
  readonly decompiledUrl: string;

  /**
   * Files contained in the WASM symbols.
   */
  readonly files: readonly string[];

  /**
   * Returns disassembled wasm lines.
   */
  getDisassembly(): Promise<string>;

  /**
   * Gets the source position for the given position in compiled code.
   *
   * Following CDP semantics, it assumes the column is being the byte offset
   * in webassembly. However, we encode the inline frame index in the line.
   */
  originalPositionFor(
    compiledPosition: IPosition,
  ): Promise<{ url: string; position: IPosition } | undefined>;

  /**
   * Gets the position in the disassembly for the given position in compiled code.
   *
   * Following CDP semantics, it assumes the column is being the byte offset
   * in webassembly. However, we encode the inline frame index in the line.
   */
  disassembledPositionFor(
    compiledPosition: IPosition,
  ): Promise<{ url: string; position: IPosition } | undefined>;

  /**
   * Gets the compiled position for the given position in source code.
   *
   * Following CDP semantics, it assumes the position is line 0 with the column
   * offset being the byte offset in webassembly.
   */
  compiledPositionFor(sourceUrl: string, sourcePosition: IPosition): Promise<IPosition[]>;

  /**
   * Gets variables in the program scope at the given position. If not
   * implemented, the variable store should use its default behavior.
   *
   * Following CDP semantics, it assumes the column is being the byte offset
   * in webassembly. However, we encode the inline frame index in the line.
   */
  getVariablesInScope?(callFrameId: string, position: IPosition): Promise<IWasmVariable[]>;

  /**
   * Gets the stack of WASM functions at the given position. Generally this will
   * return an element with a single item containing the function name. However,
   * inlined functions may return multiple functions for a position.
   *
   * It may return an empty array if function information is not available.
   *
   * @see https://github.com/ChromeDevTools/devtools-frontend/blob/c9f204731633fd2e2b6999a2543e99b7cc489b4b/docs/language_extension_api.md#dealing-with-inlined-functions
   */
  getFunctionStack?(position: IPosition): Promise<{ name: string }[]>;

  /**
   * Evaluates the expression at a position.
   *
   * Following CDP semantics, it assumes the column is being the byte offset
   * in webassembly. However, we encode the inline frame index in the line.
   */
  evaluate?(
    callFrameId: string,
    position: IPosition,
    expression: string,
  ): Promise<Cdp.Runtime.RemoteObject | undefined>;

  /**
   * Gets ranges that should be stepped for the given step kind and location.
   *
   * Following CDP semantics, it assumes the column is being the byte offset
   * in webassembly. However, we encode the inline frame index in the line.
   */
  getStepSkipList?(
    direction: StepDirection,
    position: IPosition,
    sourceUrl?: string,
    mappedPosition?: IPosition,
  ): Promise<Range[]>;
}

class DecompiledWasmSymbols implements IWasmSymbols {
  /** @inheritdoc */
  public readonly decompiledUrl: string;

  /** @inheritdoc */
  public readonly files: readonly string[];

  /** Called whenever disassembly is requested for a source/ */
  public onDidDisassemble?: () => void;

  constructor(
    protected readonly event: Cdp.Debugger.ScriptParsedEvent,
    protected readonly cdp: Cdp.Api,
    files: string[],
  ) {
    this.decompiledUrl = ensureWATExtension(event.url);
    files.push(this.decompiledUrl);
    this.files = files;
  }

  /** @inheritdoc */
  public async getDisassembly(): Promise<string> {
    const { lines } = await this.doDisassemble();
    this.onDidDisassemble?.();
    return lines.join('\n');
  }

  /** @inheritdoc */
  public originalPositionFor(
    compiledPosition: IPosition,
  ): Promise<{ url: string; position: IPosition } | undefined> {
    return this.disassembledPositionFor(compiledPosition);
  }

  /** @inheritdoc */
  public async disassembledPositionFor(
    compiledPosition: IPosition,
  ): Promise<{ url: string; position: IPosition } | undefined> {
    const { byteOffsetsOfLines } = await this.doDisassemble();
    const lineNumber = binarySearch(
      byteOffsetsOfLines,
      compiledPosition.base0.columnNumber,
      (a, b) => a - b,
    );

    if (lineNumber === byteOffsetsOfLines.length) {
      return undefined;
    }

    return {
      url: this.decompiledUrl,
      position: new Base0Position(lineNumber, 0),
    };
  }

  /** @inheritdoc */
  public async compiledPositionFor(
    sourceUrl: string,
    sourcePosition: IPosition,
  ): Promise<IPosition[]> {
    if (sourceUrl !== this.decompiledUrl) {
      return [];
    }

    const { byteOffsetsOfLines } = await this.doDisassemble();
    const { lineNumber } = sourcePosition.base0;
    if (lineNumber >= byteOffsetsOfLines.length) {
      return [];
    }

    const columnNumber = byteOffsetsOfLines[sourcePosition.base0.lineNumber];
    return [new Base0Position(0, columnNumber)];
  }

  public dispose(): void {
    // no-op
  }

  /**
   * Memoized disassembly. Returns two things:
   *
   * 1. byteOffsetsOfLines: Mapping of bytecode offsets where line numbers
   *    begin. For example, line 42 begins at `byteOffsetsOfLines[42]`.
   * 2. lines: disassembled WAT lines.
   */
  private readonly doDisassemble = once(async () => {
    let lines: string[] = [];
    let byteOffsetsOfLines: Uint32Array | undefined;

    for await (const chunk of this.getDisassembledStream()) {
      lines = lines.concat(chunk.lines);

      let start: number;
      if (byteOffsetsOfLines) {
        const newOffsets = new Uint32Array(byteOffsetsOfLines.length + chunk.lines.length);
        start = byteOffsetsOfLines.length;
        newOffsets.set(byteOffsetsOfLines);
        byteOffsetsOfLines = newOffsets;
      } else {
        byteOffsetsOfLines = new Uint32Array(chunk.lines.length);
        start = 0;
      }

      for (let i = 0; i < chunk.lines.length; i++) {
        byteOffsetsOfLines[start + i] = chunk.bytecodeOffsets[i];
      }
    }

    byteOffsetsOfLines ??= new Uint32Array(0);

    return { lines, byteOffsetsOfLines };
  });

  private async *getDisassembledStream() {
    const { scriptId } = this.event;
    const r = await this.cdp.Debugger.disassembleWasmModule({ scriptId });
    if (!r) {
      return;
    }

    yield r.chunk;

    while (r.streamId) {
      const r2 = await this.cdp.Debugger.nextWasmDisassemblyChunk({ streamId: r.streamId });
      if (!r2) {
        return;
      }
      yield r2.chunk;
    }
  }
}

class WasmSymbols extends DecompiledWasmSymbols {
  private readonly mappedLines = new Map</* source URL */ string, Promise<Uint32Array>>();
  private get codeOffset() {
    return this.event.codeOffset || 0;
  }

  constructor(
    event: Cdp.Debugger.ScriptParsedEvent,
    cdp: Cdp.Api,
    private readonly moduleId: string,
    private readonly worker: IWasmWorkerExt,
    files: string[],
  ) {
    super(event, cdp, files);
  }

  /** @inheritdoc */
  public override async originalPositionFor(
    compiledPosition: IPosition,
  ): Promise<{ url: string; position: IPosition } | undefined> {
    const locations = await this.worker.rpc.sendMessage('rawLocationToSourceLocation', {
      codeOffset: compiledPosition.base0.columnNumber - this.codeOffset,
      inlineFrameIndex: compiledPosition.base0.lineNumber,
      rawModuleId: this.moduleId,
    });

    if (!locations.length) {
      return super.originalPositionFor(compiledPosition);
    }

    return {
      position: new Base0Position(locations[0].lineNumber, locations[0].columnNumber),
      url: locations[0].sourceFileURL,
    };
  }

  /** @inheritdoc */
  public override async compiledPositionFor(
    sourceUrl: string,
    sourcePosition: IPosition,
  ): Promise<IPosition[]> {
    if (sourceUrl === this.decompiledUrl) {
      return super.compiledPositionFor(sourceUrl, sourcePosition);
    }

    const { lineNumber, columnNumber } = sourcePosition.base0;
    const locations = await this.worker.rpc.sendMessage('sourceLocationToRawLocation', {
      lineNumber,
      columnNumber: columnNumber === 0 ? -1 : columnNumber,
      rawModuleId: this.moduleId,
      sourceFileURL: sourceUrl,
    });

    // special case: unlike sourcemaps, if we resolve a location on a line
    // with nothing on it, sourceLocationToRawLocation returns undefined.
    // If we think this might have happened, verify it and then get
    // the next mapped line and use that location.
    if (columnNumber === 0 && locations.length === 0) {
      const mappedLines = await this.getMappedLines(sourceUrl);
      const next = mappedLines.find(l => l > lineNumber);
      if (!mappedLines.includes(lineNumber) && next /* always > 0 */) {
        return this.compiledPositionFor(sourceUrl, new Base0Position(next, 0));
      }
    }

    // todo@connor4312: will there ever be a location in another module?
    return locations
      .filter(l => l.rawModuleId === this.moduleId)
      .map(l => new Base0Position(0, this.codeOffset + l.startOffset));
  }

  /** @inheritdoc */
  public override dispose() {
    return this.worker.rpc.sendMessage('removeRawModule', this.moduleId);
  }

  /** @inheritdoc */
  public async getVariablesInScope(
    callFrameId: string,
    position: IPosition,
  ): Promise<IWasmVariable[]> {
    const location = {
      codeOffset: position.base0.columnNumber - this.codeOffset,
      inlineFrameIndex: position.base0.lineNumber,
      rawModuleId: this.moduleId,
    };

    const variables = await this.worker.rpc.sendMessage('listVariablesInScope', location);

    return variables.map(
      (v): IWasmVariable => ({
        name: v.name,
        scope: v.scope as WasmScope,
        type: v.type,
        evaluate: async () => {
          const result = await this.worker.rpc.sendMessage(
            'evaluate',
            v.name,
            location,
            this.worker.getStopId(callFrameId),
          );
          return result ? new WasmVariableEvaluation(result, this.worker.rpc) : nullType;
        },
      }),
    );
  }

  /** @inheritdoc */
  public async getFunctionStack(position: IPosition): Promise<{ name: string }[]> {
    const info = await this.worker.rpc.sendMessage('getFunctionInfo', {
      codeOffset: position.base0.columnNumber - this.codeOffset,
      inlineFrameIndex: position.base0.lineNumber,
      rawModuleId: this.moduleId,
    });

    return 'frames' in info ? info.frames : [];
  }

  /** @inheritdoc */
  public async getStepSkipList(
    direction: StepDirection,
    position: IPosition,
    sourceUrl?: string,
    mappedPosition?: IPosition,
  ): Promise<Range[]> {
    if (sourceUrl === this.decompiledUrl) {
      return [];
    }

    const thisLocation = {
      codeOffset: position.base0.columnNumber - this.codeOffset,
      inlineFrameIndex: position.base0.lineNumber,
      rawModuleId: this.moduleId,
    };

    const getOwnLineRanges = () => {
      if (!(mappedPosition && sourceUrl)) {
        return [];
      }
      return this.worker.rpc.sendMessage('sourceLocationToRawLocation', {
        lineNumber: mappedPosition.base0.lineNumber,
        columnNumber: -1,
        rawModuleId: this.moduleId,
        sourceFileURL: sourceUrl,
      });
    };

    let rawRanges: Chrome.DevTools.RawLocationRange[];
    switch (direction) {
      case StepDirection.Out: {
        // Step out should step out of inline functions.
        rawRanges = await this.worker.rpc.sendMessage('getInlinedFunctionRanges', thisLocation);
        break;
      }
      case StepDirection.Over: {
        // step over should both step over inline functions and any
        // intermediary statements on this line, which may exist
        // in WAT assembly but not in source code.
        const ranges = await Promise.all([
          this.worker.rpc.sendMessage('getInlinedCalleesRanges', thisLocation),
          getOwnLineRanges(),
        ]);
        rawRanges = flatten(ranges);
        break;
      }
      case StepDirection.In:
        // Step in should skip over any intermediary statements on this line
        rawRanges = await getOwnLineRanges();
        break;
      default:
        rawRanges = [];
        break;
    }

    return rawRanges.map(
      r =>
        new Range(
          new Base0Position(0, r.startOffset + this.codeOffset),
          new Base0Position(0, r.endOffset + this.codeOffset),
        ),
    );
  }

  /** @inheritdoc */
  public async evaluate(
    callFrameId: string,
    position: IPosition,
    expression: string,
  ): Promise<Cdp.Runtime.RemoteObject | undefined> {
    try {
      const r = await this.worker.rpc.sendMessage(
        'evaluate',
        expression,
        {
          codeOffset: position.base0.columnNumber - this.codeOffset,
          inlineFrameIndex: position.base0.lineNumber,
          rawModuleId: this.moduleId,
        },
        this.worker.getStopId(callFrameId),
      );

      // cast since types in dwarf-debugging are slightly different than generated cdp API
      return (r as Cdp.Runtime.RemoteObject) ?? undefined;
    } catch (e) {
      // errors are expected here if the user tries to evaluate expressions
      // the simple lldb-eval can't handle.
      throw new ProtocolError(errors.createSilentError(e.message));
    }
  }

  private getMappedLines(sourceURL: string) {
    const prev = this.mappedLines.get(sourceURL);
    if (prev) {
      return prev;
    }

    const value = (async () => {
      try {
        const lines = await this.worker.rpc.sendMessage(
          'getMappedLines',
          this.moduleId,
          sourceURL,
        );
        return new Uint32Array(lines?.sort((a, b) => a - b) || []);
      } catch {
        return new Uint32Array();
      }
    })();

    this.mappedLines.set(sourceURL, value);
    return value;
  }
}

const nullType: IWasmVariableEvaluation = {
  type: 'null',
  description: 'no properties',
};

class WasmVariableEvaluation implements IWasmVariableEvaluation {
  public readonly type: string;
  public readonly description: string | undefined;
  public readonly linearMemoryAddress: number | undefined;
  public readonly linearMemorySize: number | undefined;

  public readonly getChildren?: () => Promise<{ name: string; value: IWasmVariableEvaluation }[]>;

  constructor(evaluation: NonNullable<MethodReturn<'evaluate'>>, rpc: IWasmWorker['rpc']) {
    this.type = evaluation.type;
    this.description = evaluation.description;
    this.linearMemoryAddress = evaluation.linearMemoryAddress;
    this.linearMemorySize = evaluation.linearMemoryAddress;

    if (evaluation.objectId && evaluation.hasChildren) {
      const oid = evaluation.objectId;
      this.getChildren = once(() => this._getChildren(rpc, oid));
    }
  }

  private async _getChildren(
    rpc: IWasmWorker['rpc'],
    objectId: string,
  ): Promise<{ name: string; value: IWasmVariableEvaluation }[]> {
    const vars = await rpc.sendMessage('getProperties', objectId);
    return vars.map(v => ({
      name: v.name,
      value: new WasmVariableEvaluation(v.value, rpc),
    }));
  }
}
