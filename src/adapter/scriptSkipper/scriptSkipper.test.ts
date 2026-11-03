/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { expect } from 'chai';
import Cdp from '../../cdp/api';
import { Logger } from '../../common/logging/logger';
import { upcastPartial } from '../../common/objUtils';
import { ISourcePathResolver } from '../../common/sourcePathResolver';
import { AnyLaunchConfiguration } from '../../configuration';
import { ITarget } from '../../targets/targets';
import { ScriptSkipper } from './implementation';

describe('ScriptSkipper', () => {
  let skipper: ScriptSkipper | undefined;
  let blackboxPatterns: string[] = [];

  const createSkipper = (skipFiles: string[]) => {
    const cdp = upcastPartial<Cdp.Api>({
      Debugger: upcastPartial<Cdp.DebuggerApi>({
        setBlackboxPatterns: async ({ patterns }) => {
          blackboxPatterns = patterns;
          return {};
        },
      }),
      Runtime: upcastPartial<Cdp.RuntimeApi>({
        evaluate: async () => ({ result: { type: 'object', value: ['events', 'fs'] } }),
      }),
    });

    skipper = new ScriptSkipper(
      upcastPartial<AnyLaunchConfiguration>({ skipFiles }),
      upcastPartial<ISourcePathResolver>({ rebaseLocalToRemote: p => p }),
      Logger.null,
      cdp,
      upcastPartial<ITarget>({ type: () => 'node', id: () => 'a', parent: () => undefined }),
    );

    return skipper;
  };

  const isBlackboxed = (url: string) => blackboxPatterns.some(p => new RegExp(p, 'i').test(url));

  afterEach(() => {
    skipper?.dispose();
    skipper = undefined;
    blackboxPatterns = [];
  });

  const lodash = 'file:///proj/node_modules/lodash/index.js';
  const math = 'file:///proj/node_modules/math/index.js';

  it('applies relative negations', () => {
    const s = createSkipper(['**/node_modules/**', '!**/node_modules/math/**']);
    expect(s.isScriptSkipped(lodash)).to.be.true;
    expect(s.isScriptSkipped(math)).to.be.false;
    expect(isBlackboxed(lodash)).to.be.true;
    expect(isBlackboxed(math)).to.be.false;
  });

  it('applies absolute negations', () => {
    // e.g. "!${workspaceFolder}/node_modules/math/**" once variables are resolved
    const s = createSkipper(['/proj/node_modules/**', '!/proj/node_modules/math/**']);
    expect(s.isScriptSkipped(lodash)).to.be.true;
    expect(s.isScriptSkipped(math)).to.be.false;
    expect(isBlackboxed(lodash)).to.be.true;
    expect(isBlackboxed(math)).to.be.false;
  });

  it('applies absolute negations to relative globs', () => {
    const s = createSkipper(['**/node_modules/**', '!/proj/node_modules/math/**']);
    expect(s.isScriptSkipped(lodash)).to.be.true;
    expect(s.isScriptSkipped(math)).to.be.false;
    expect(isBlackboxed(lodash)).to.be.true;
    expect(isBlackboxed(math)).to.be.false;
  });

  it('applies node internals negations', async () => {
    // Node 15+ names internals `node:events`, shown as `<node_internals>/events`
    const s = createSkipper(['<node_internals>/**', '!<node_internals>/events']);
    await new Promise(r => setImmediate(r)); // let the builtin module list load
    expect(s.isScriptSkipped('node:fs')).to.be.true;
    expect(s.isScriptSkipped('node:events')).to.be.false;
  });

  it('applies node internals negations to Node 14 module names', async () => {
    // before Node 15, internals are named `events.js`
    const s = createSkipper(['<node_internals>/**', '!<node_internals>/events.js']);
    await new Promise(r => setImmediate(r));
    expect(s.isScriptSkipped('fs.js')).to.be.true;
    expect(s.isScriptSkipped('events.js')).to.be.false;
    expect(isBlackboxed('fs.js')).to.be.true;
    expect(isBlackboxed('events.js')).to.be.false;
  });

  it('ignores node internals negations without a positive glob', async () => {
    const s = createSkipper(['!<node_internals>/events']);
    await new Promise(r => setImmediate(r));
    expect(s.isScriptSkipped('node:fs')).to.be.false;
    expect(s.isScriptSkipped('node:events')).to.be.false;
  });

  it('keeps node internals globs that start with an extglob', async () => {
    const s = createSkipper(['<node_internals>/!(events)']);
    await new Promise(r => setImmediate(r));
    expect(s.isScriptSkipped('node:fs')).to.be.true;
    expect(s.isScriptSkipped('node:events')).to.be.false;
  });
});
