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
import { StackFrame } from './stackTrace';
import { getSourceSuffix } from './templates';
import { Thread } from './threads';

export const IWasmSymbolProvider = Symbol('IWasmSymbolProvider');

export interface IWasmSymbolProvider {
  /** Sets the thread, required to interact with the stacktrace state */
  setThread(thread: Thread): void;

  /** Loads WebAssembly symbols for the given wasm script, returning symbol information if it exists. */
  loadWasmSymbols(script: Cdp.Debugger.ScriptParsedEvent): Promise<IWasmSymbols>;
}

@injectable()
export class StubWasmSymbolProvider implements IWasmSymbolProvider {
  constructor(@inject(ICdpApi) private readonly cdp: Cdp.Api) {}

  setThread(): void {
    // no-op
  }

  public loadWasmSymbols(script: Cdp.Debugger.ScriptParsedEvent): Promise<IWasmSymbols> {
    return Promise.resolve(new DecompiledWasmSymbols(script, this.cdp, []));
  }
}

@injectable()
export class WasmSymbolProvider implements IWasmSymbolProvider, IDisposable {
  private worker?: IWasmWorker;
  private thread!: Thread;

  constructor(
    private readonly spawnDwarf: typeof spawn,
    @inject(ICdpApi) private readonly cdp: Cdp.Api,
    @inject(ILogger) private readonly logger: ILogger,
  ) {}

  /** @inheritdoc */
  public setThread(thread: Thread) {
    this.thread = thread;
  }

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
        ),
    });

    this.worker.rpc.sendMessage('hello', [], false);

    return this.worker.rpc;
  }

  private async loadWasmValue(expression: string, stopId: unknown) {
    const frame = this.stopIdToFrame(stopId as bigint);
    const callFrameId = frame.callFrameId();
    if (!callFrameId) {
      throw new Error('variables not available on this frame');
    }

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

  private stopIdToFrame(stopId: bigint): StackFrame {
    const frame = this.thread.pausedDetails()?.stackTrace.frames[Number(stopId)];
    if (!frame || !('callFrameId' in frame)) {
      throw new Error('frame not found');
    }

    return frame;
  }
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
   * Following CDP semantics, it assumes the position is line 0 with the column
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
      columnNumber: columnNumber === 0 ? -1 : 0,
      rawModuleId: this.moduleId,
      sourceFileURL: sourceUrl,
    });

    // todo@connor4312: will there ever be a location in another module?
    const location = locations.find(l => l.rawModuleId === this.moduleId);
    return location && new Base0Position(0, this.codeOffset + locations[0].startOffset);
  }

  /** @inheritdoc */
  public override dispose() {
    return this.rpc.sendMessage('removeRawModule', this.moduleId);
  }
}
