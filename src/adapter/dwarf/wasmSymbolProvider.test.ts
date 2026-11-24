/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import type { Chrome } from '@vscode/dwarf-debugging/chrome-cxx/mnt/extension-api';
import { expect } from 'chai';
import Cdp from '../../cdp/api';
import { Logger } from '../../common/logging/logger';
import { upcastPartial } from '../../common/objUtils';
import { Base0Position, Base1Position } from '../../common/positions';
import { edgeLaunchConfigDefaults } from '../../configuration';
import { IWasmWorkerExt, IWasmWorkerFactory, WasmSymbolProvider } from './wasmSymbolProvider';

describe('WasmSymbolProvider', () => {
  function createProvider(options: {
    mappedLines: readonly number[];
    locationsByLine?: Record<number, Chrome.DevTools.RawLocationRange[]>;
  }) {
    const rawLocationCalls: Chrome.DevTools.SourceLocation[] = [];
    let moduleId = '';

    const worker = upcastPartial<IWasmWorkerExt>({
      rpc: upcastPartial<IWasmWorkerExt['rpc']>({
        sendMessage: (async (method: string, ...args: unknown[]) => {
          switch (method) {
            case 'addRawModule':
              moduleId = args[0] as string;
              return ['file:///main.cpp'];
            case 'getMappedLines':
              return options.mappedLines;
            case 'sourceLocationToRawLocation': {
              const loc = args[0] as Chrome.DevTools.SourceLocation;
              rawLocationCalls.push(loc);
              if (loc.lineNumber < -2147483648 || loc.lineNumber > 2147483647) {
                throw new TypeError(
                  `Passing a number "${loc.lineNumber}" from JS side to C/C++ side to an argument of type "int", which is outside the valid range [-2147483648, 2147483647]!`,
                );
              }
              return (options.locationsByLine?.[loc.lineNumber] ?? []).map(r => ({
                ...r,
                rawModuleId: moduleId,
              }));
            }
            default:
              return [];
          }
        }) as IWasmWorkerExt['rpc']['sendMessage'],
      }),
    });

    const factory = upcastPartial<IWasmWorkerFactory>({
      spawn: async () => worker,
    });

    const provider = new WasmSymbolProvider(
      factory,
      upcastPartial<Cdp.Api>({}),
      Logger.null,
      { ...edgeLaunchConfigDefaults, enableDWARF: true },
    );

    const script = upcastPartial<Cdp.Debugger.ScriptParsedEvent>({
      scriptId: 'script-1',
      url: 'http://localhost:8080/main.wasm',
      codeOffset: 100,
      debugSymbols: [
        { type: 'EmbeddedDWARF', externalURL: 'http://localhost:8080/main.wasm' },
      ],
    });

    return { provider, script, rawLocationCalls };
  }

  it('ignores negative mapped lines when resolving an unmapped breakpoint (#2456)', async () => {
    const { provider, script, rawLocationCalls } = createProvider({
      mappedLines: [-1, 9, 10, 11],
      locationsByLine: {
        9: [{ rawModuleId: '', startOffset: 42, endOffset: 50 }],
      },
    });

    const symbols = await provider.loadWasmSymbols(script);
    const positions = await symbols.compiledPositionFor(
      'file:///main.cpp',
      new Base1Position(8, 1),
    );

    expect(positions.map(p => p.base0)).to.deep.equal([new Base0Position(0, 142)]);
    expect(rawLocationCalls.map(c => c.lineNumber)).to.deep.equal([7, 9]);
  });

  it('sorts unsorted mapped lines without mutating the array', async () => {
    const mappedLines = Object.freeze([10, -1, 9, 11]);
    const { provider, script, rawLocationCalls } = createProvider({
      mappedLines,
      locationsByLine: {
        9: [{ rawModuleId: '', startOffset: 42, endOffset: 50 }],
      },
    });

    const symbols = await provider.loadWasmSymbols(script);
    const positions = await symbols.compiledPositionFor(
      'file:///main.cpp',
      new Base1Position(8, 1),
    );

    expect(positions.map(p => p.base0)).to.deep.equal([new Base0Position(0, 142)]);
    expect(rawLocationCalls.map(c => c.lineNumber)).to.deep.equal([7, 9]);
  });

  it('returns no positions when getMappedLines only contains negative lines', async () => {
    const { provider, script, rawLocationCalls } = createProvider({
      mappedLines: [-1],
    });

    const symbols = await provider.loadWasmSymbols(script);
    const positions = await symbols.compiledPositionFor(
      'file:///main.cpp',
      new Base1Position(8, 1),
    );

    expect(positions).to.deep.equal([]);
    expect(rawLocationCalls.map(c => c.lineNumber)).to.deep.equal([7]);
  });
});
