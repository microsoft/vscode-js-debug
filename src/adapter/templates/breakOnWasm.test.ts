/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { expect } from 'chai';
import * as inspector from 'inspector';
import * as vm from 'vm';
import { Worker } from 'worker_threads';
import { breakOnWasmInit, breakOnWasmSourceUrl } from './breakOnWasm';

const minimalWasm = new Uint8Array([
  0x00,
  0x61,
  0x73,
  0x6d, // magic
  0x01,
  0x00,
  0x00,
  0x00, // version
  0x01,
  0x04,
  0x01,
  0x60,
  0x00,
  0x00, // type () -> ()
  0x03,
  0x02,
  0x01,
  0x00, // function section
  0x07,
  0x05,
  0x01,
  0x01,
  0x66,
  0x00,
  0x00, // export "f"
  0x0a,
  0x04,
  0x01,
  0x02,
  0x00,
  0x0b, // code section
]);

const post = (session: inspector.Session, method: 'Debugger.enable' | 'Debugger.disable') =>
  new Promise<void>((resolve, reject) =>
    session.post(method, (err: Error | null) => (err ? reject(err) : resolve()))
  );

describe('breakOnWasmInit', () => {
  const withPauseCounter = async (
    fn: (getPauseCount: () => number) => Promise<void>,
  ): Promise<void> => {
    const session = new inspector.Session();
    session.connect();
    const scripts = new Map<string, string>();
    let pauses = 0;

    session.on('Debugger.scriptParsed', event => {
      scripts.set(event.params.scriptId, event.params.url);
    });
    session.on('Debugger.paused', event => {
      const scriptId = event.params.callFrames[0]?.location.scriptId;
      if (scriptId && scripts.get(scriptId) === breakOnWasmSourceUrl) {
        pauses++;
      }
      session.post('Debugger.resume');
    });

    await post(session, 'Debugger.enable');
    try {
      await fn(() => pauses);
    } finally {
      await post(session, 'Debugger.disable');
      session.disconnect();
    }
  };

  const createInstrumentedContext = () => {
    const ctx = vm.createContext({ wasmBytes: new Uint8Array(minimalWasm) });
    vm.runInContext(breakOnWasmInit.expr(), ctx);
    return ctx;
  };

  it('pauses once when compiling and skips redundant pause on same-context instantiate', async () => {
    await withPauseCounter(async getPauseCount => {
      const ctx = createInstrumentedContext();
      await vm.runInContext(
        `(async () => {
          const mod = await WebAssembly.compile(wasmBytes);
          await WebAssembly.instantiate(mod);
        })()`,
        ctx,
      );
      expect(getPauseCount()).to.equal(1);
    });
  });

  it('pauses once on WebAssembly.instantiate(bytes) and skips redundant pause for returned module', async () => {
    await withPauseCounter(async getPauseCount => {
      const ctx = createInstrumentedContext();
      await vm.runInContext(
        `(async () => {
          const { module } = await WebAssembly.instantiate(wasmBytes);
          await WebAssembly.instantiate(module);
        })()`,
        ctx,
      );
      expect(getPauseCount()).to.equal(1);
    });
  });

  it('pauses on first instantiate of an unseen WebAssembly.Module in the context and skips repeats', async () => {
    await withPauseCounter(async getPauseCount => {
      const ctx = createInstrumentedContext();
      await vm.runInContext(
        `(async () => {
          const mod = new WebAssembly.Module(wasmBytes);
          await WebAssembly.instantiate(mod);
          await WebAssembly.instantiate(mod);
        })()`,
        ctx,
      );
      expect(getPauseCount()).to.equal(1);
    });
  });

  it('pauses in a worker the first time it instantiates a transferred WebAssembly.Module', async () => {
    const compiled = await WebAssembly.compile(minimalWasm);
    const counts = await new Promise<{ afterFirst: number; afterSecond: number }>(
      (resolve, reject) => {
        const worker = new Worker(
          `
          const inspector = require('inspector');
          const vm = require('vm');
          const { parentPort, workerData } = require('worker_threads');

          const session = new inspector.Session();
          session.connect();
          const scripts = new Map();
          let pauses = 0;
          session.on('Debugger.scriptParsed', event => {
            scripts.set(event.params.scriptId, event.params.url);
          });
          session.on('Debugger.paused', event => {
            const scriptId = event.params.callFrames[0]?.location.scriptId;
            if (scriptId && scripts.get(scriptId) === workerData.sourceUrl) {
              pauses++;
            }
            session.post('Debugger.resume');
          });
          session.post('Debugger.enable', () => {
            vm.runInThisContext(workerData.expr);
            parentPort.once('message', async mod => {
              try {
                await WebAssembly.instantiate(mod);
                const afterFirst = pauses;
                await WebAssembly.instantiate(mod);
                const afterSecond = pauses;
                parentPort.postMessage({ afterFirst, afterSecond });
              } catch (err) {
                parentPort.postMessage({ error: String(err) });
              } finally {
                session.post('Debugger.disable', () => session.disconnect());
              }
            });
            parentPort.postMessage('ready');
          });
          `,
          {
            eval: true,
            workerData: {
              expr: breakOnWasmInit.expr(),
              sourceUrl: breakOnWasmSourceUrl,
            },
          },
        );

        worker.on('error', reject);
        worker.on('message', msg => {
          if (msg === 'ready') {
            worker.postMessage(compiled);
          } else if (msg && 'error' in msg) {
            worker.terminate();
            reject(new Error(msg.error));
          } else {
            worker.terminate();
            resolve(msg);
          }
        });
      },
    );

    expect(counts).to.deep.equal({ afterFirst: 1, afterSecond: 1 });
  });
});
