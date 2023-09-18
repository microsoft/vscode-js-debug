/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import type { IWasmWorker, MethodReturn, spawn } from '@vscode/dwarf-debugging';
import { randomUUID } from 'crypto';
import { inject, injectable } from 'inversify';
import Cdp from '../cdp/api';
import { ICdpApi } from '../cdp/connection';
import { binarySearch } from '../common/arrayUtils';
import { IDisposable } from '../common/disposable';
import { ILogger, LogTag } from '../common/logging';
import { once } from '../common/objUtils';
import { Base0Position, IPosition } from '../common/positions';
import { getSourceSuffix } from './templates';

export const IWasmSymbolProvider = Symbol('IWasmSymbolProvider');

export interface IWasmSymbolProvider {
  /** Loads WebAssembly symbols for the given wasm script, returning symbol information if it exists. */
  loadWasmSymbols(script: Cdp.Debugger.ScriptParsedEvent): Promise<IWasmSymbols>;
}

@injectable()
export class StubWasmSymbolProvider implements IWasmSymbolProvider {
  constructor(@inject(ICdpApi) private readonly cdp: Cdp.Api) {}

  public loadWasmSymbols(script: Cdp.Debugger.ScriptParsedEvent): Promise<IWasmSymbols> {
    return Promise.resolve(new DecompiledWasmSymbols(script, this.cdp, []));
  }
}

@injectable()
export class WasmSymbolProvider implements IWasmSymbolProvider, IDisposable {
  private worker?: IWasmWorker;

  constructor(
    private readonly spawnDwarf: typeof spawn,
    @inject(ICdpApi) private readonly cdp: Cdp.Api,
    @inject(ILogger) private readonly logger: ILogger,
  ) {}

  public async loadWasmSymbols(script: Cdp.Debugger.ScriptParsedEvent): Promise<IWasmSymbols> {
    const rpc = await this.getWorker();
    const moduleId = randomUUID();

    const symbolsUrl = script.debugSymbols?.externalURL;
    let result: MethodReturn<'addRawModule'>;
    try {
      result = await rpc.sendMessage('addRawModule', moduleId, symbolsUrl, {
        url: script.url,
        code:
          !symbolsUrl && script.url.startsWith('wasm://')
            ? await this.getBytecode(script.scriptId)
            : undefined,
      });
    } catch {
      return new DecompiledWasmSymbols(script, this.cdp, []);
    }

    if (!(result instanceof Array) || result.length === 0) {
      rpc.sendMessage('removeRawModule', moduleId); // no await necessary
      return new DecompiledWasmSymbols(script, this.cdp, []);
    }

    this.logger.info(LogTag.SourceMapParsing, 'parsed files from wasm', { files: result });

    return new WasmSymbols(script, this.cdp, moduleId, rpc, result);
  }

  /** @inheritdoc */
  public dispose(): void {
    this.worker?.dispose();
    this.worker = undefined;
  }

  private async getBytecode(scriptId: string) {
    const source = await this.cdp.Debugger.getScriptSource({ scriptId });
    const bytecode = source?.bytecode;
    return bytecode ? Buffer.from(bytecode, 'base64').buffer : undefined;
  }

  private async getWorker() {
    if (this.worker) {
      return this.worker.rpc;
    }

    this.worker = this.spawnDwarf({
      getWasmGlobal: (index, stopId) => this.loadWasmValue(`globals[${index}]`, stopId),
      getWasmLocal: (index, stopId) => this.loadWasmValue(`locals[${index}]`, stopId),
      getWasmOp: (index, stopId) => this.loadWasmValue(`stack[${index}]`, stopId),
      getWasmLinearMemory: (offset, length, stopId) =>
        this.loadWasmValue(
          `[].slice.call(new Uint8Array(memories[0].buffer, ${+offset}, ${+length}))`,
          stopId,
        ).then((v: number[]) => new Uint8Array(v).buffer),
    });

    this.worker.rpc.sendMessage('hello', [], false);

    return this.worker.rpc;
  }

  private async loadWasmValue(expression: string, stopId: unknown) {
    const callFrameId = stopId as string;
    const result = await this.cdp.Debugger.evaluateOnCallFrame({
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
   * Following CDP semantics, it returns a position on line 0 with the column
   * offset being the byte offset in webassembly.
   */
  originalPositionFor(
    compiledPosition: IPosition,
  ): Promise<{ url: string; position: IPosition } | undefined>;

  /**
   * Gets the compiled position for the given position in source code.
   *
   * Following CDP semantics, it assumes the position is line 0 with the column
   * offset being the byte offset in webassembly.
   */
  compiledPositionFor(sourceUrl: string, sourcePosition: IPosition): Promise<IPosition | undefined>;

  /**
   * Gets variables in the program scope at the given position. If not
   * implemented, the variable store should use its default behavior.
   *
   * Following CDP semantics, it assumes the position is line 0 with the column
   * offset being the byte offset in webassembly.
   */
  getVariablesInScope?(callFrameId: string, position: IPosition): Promise<IWasmVariable[]>;
}

class DecompiledWasmSymbols implements IWasmSymbols {
  /** @inheritdoc */
  public readonly decompiledUrl: string;

  /** @inheritdoc */
  public readonly files: readonly string[];

  constructor(
    protected readonly event: Cdp.Debugger.ScriptParsedEvent,
    protected readonly cdp: Cdp.Api,
    files: string[],
  ) {
    files.push((this.decompiledUrl = event.url.replace('.wasm', '.wat')));
    this.files = files;
  }

  /** @inheritdoc */
  public async getDisassembly(): Promise<string> {
    const { lines } = await this.doDisassemble();
    return lines.join('\n');
  }

  /** @inheritdoc */
  public async originalPositionFor(
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
  ): Promise<IPosition | undefined> {
    if (sourceUrl !== this.decompiledUrl) {
      return undefined;
    }

    const { byteOffsetsOfLines } = await this.doDisassemble();
    const { lineNumber } = sourcePosition.base0;
    if (lineNumber >= byteOffsetsOfLines.length) {
      return undefined;
    }

    const columnNumber = byteOffsetsOfLines[sourcePosition.base0.lineNumber];
    return new Base0Position(0, columnNumber);
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
    private readonly rpc: IWasmWorker['rpc'],
    files: string[],
  ) {
    super(event, cdp, files);
  }

  /** @inheritdoc */
  public override async originalPositionFor(
    compiledPosition: IPosition,
  ): Promise<{ url: string; position: IPosition } | undefined> {
    const locations = await this.rpc.sendMessage('rawLocationToSourceLocation', {
      codeOffset: compiledPosition.base0.columnNumber - this.codeOffset,
      inlineFrameIndex: 0,
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
  ): Promise<IPosition | undefined> {
    const { lineNumber, columnNumber } = sourcePosition.base0;
    const locations = await this.rpc.sendMessage('sourceLocationToRawLocation', {
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
    const location = locations.find(l => l.rawModuleId === this.moduleId);
    return location && new Base0Position(0, this.codeOffset + locations[0].startOffset);
  }

  /** @inheritdoc */
  public override dispose() {
    return this.rpc.sendMessage('removeRawModule', this.moduleId);
  }

  /** @inheritdoc */
  public async getVariablesInScope(
    callFrameId: string,
    position: IPosition,
  ): Promise<IWasmVariable[]> {
    const location = {
      codeOffset: position.base0.columnNumber - this.codeOffset,
      inlineFrameIndex: 0,
      rawModuleId: this.moduleId,
    };

    const variables = await this.rpc.sendMessage('listVariablesInScope', location);

    return variables.map(
      (v): IWasmVariable => ({
        name: v.name,
        scope: v.scope as WasmScope,
        type: v.type,
        evaluate: async () => {
          const result = await this.rpc.sendMessage('evaluate', v.name, location, callFrameId);
          return result ? new WasmVariableEvaluation(result, this.rpc) : nullType;
        },
      }),
    );
  }

  private getMappedLines(sourceURL: string) {
    const prev = this.mappedLines.get(sourceURL);
    if (prev) {
      return prev;
    }

    const value = (async () => {
      try {
        const lines = await this.rpc.sendMessage('getMappedLines', this.moduleId, sourceURL);
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
