/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { expect } from 'chai';
import Cdp from '../cdp/api';
import { stubbedCdpApi, StubCdpApi } from '../cdp/stubbedApi';
import { Logger } from '../common/logging/logger';
import { Base01Position, Range } from '../common/positions';
import { IRename, RenameMapping } from '../common/sourceMaps/renameProvider';
import { ScopeNode } from '../common/sourceMaps/renameScopeTree';
import { Evaluator } from './evaluator';

describe('Evaluator', () => {
  let evaluator: Evaluator;
  let stubCdp: StubCdpApi;
  let renameMapping: RenameMapping;

  const result: Cdp.Debugger.EvaluateOnCallFrameResult = {
    result: {
      type: 'string',
      value: 'foo',
    },
  };

  beforeEach(() => {
    stubCdp = stubbedCdpApi();
    renameMapping = RenameMapping.None;
    evaluator = new Evaluator(
      stubCdp.actual,
      {
        provideForSource: () => renameMapping,
        provideOnStackframe: () => renameMapping,
      },
      Logger.null,
    );
  });

  it('prepares simple expressions', async () => {
    const prep = evaluator.prepare('foo', { isInternalScript: false });
    expect(prep.canEvaluateDirectly).to.be.true;
    stubCdp.Debugger.evaluateOnCallFrame.resolves(result);
    expect(await prep.invoke({ callFrameId: '' })).to.equal(result);
    expect(stubCdp.Debugger.evaluateOnCallFrame.args[0][0]).to.deep.equal({
      callFrameId: '',
      expression: 'foo',
    });
  });

  it('appends eval source url to internal', async () => {
    const prep = evaluator.prepare('foo');
    expect(prep.canEvaluateDirectly).to.be.true;
    stubCdp.Debugger.evaluateOnCallFrame.resolves(result);
    expect(await prep.invoke({ callFrameId: '' })).to.equal(result);
    expect(stubCdp.Debugger.evaluateOnCallFrame.args[0][0].expression).to.match(
      /^foo\n\/\/# sourceURL=eval/m,
    );
  });

  it('replaces renamed identifiers', async () => {
    const node = new ScopeNode<IRename[]>(Range.INFINITE);
    node.data = [{ original: 'foo', compiled: 'bar' }];
    const prep = evaluator.prepare('foo', {
      isInternalScript: false,
      renames: {
        mapping: new RenameMapping(node),
        position: new Base01Position(0, 1),
      },
    });
    expect(prep.canEvaluateDirectly).to.be.true;
    stubCdp.Debugger.evaluateOnCallFrame.resolves(result);
    expect(await prep.invoke({ callFrameId: '' })).to.equal(result);
    expect(stubCdp.Debugger.evaluateOnCallFrame.args[0][0]).to.deep.equal({
      callFrameId: '',
      expression: 'typeof bar !== "undefined" ? bar : foo;\n',
    });
  });

  it('does not replace identifiers in invalid contexts', async () => {
    const node = new ScopeNode<IRename[]>(Range.INFINITE);
    node.data = [{ original: 'foo', compiled: 'bar' }];
    const prep = evaluator.prepare(
      `const baz = foo;
z.find(foo => true)
const { foo } = z;
for (const { foo } of z) {}
try {} catch ({ foo }) {}`,
      {
        isInternalScript: false,
        renames: {
          mapping: new RenameMapping(node),
          position: new Base01Position(0, 1),
        },
      },
    );
    expect(prep.canEvaluateDirectly).to.be.true;
    stubCdp.Debugger.evaluateOnCallFrame.resolves(result);
    expect(await prep.invoke({ callFrameId: '' })).to.equal(result);
    expect(stubCdp.Debugger.evaluateOnCallFrame.args[0][0]).to.deep.equal({
      callFrameId: '',
      expression: [
        `const baz = typeof bar !== \"undefined\" ? bar : foo;`,
        `z.find(bar => true);`,
        `const {bar} = z;`,
        `for (const {bar} of z) {}`,
        `try {} catch ({bar}) {}`,
        '',
      ].join('\n'),
    });
  });
});
