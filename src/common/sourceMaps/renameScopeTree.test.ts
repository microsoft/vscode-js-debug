/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { expect } from 'chai';
import { Base0Position } from '../positions';
import { PositionToOffset } from '../stringUtils';
import { extractScopeRanges, ScopeNode } from './renameScopeTree';

describe('extractScopeRanges', () => {
  const tcases: [string, string[]][] = [
    [
      'other;for (let j = 0; j < 5; ++j) { await j; }',
      ['for (let j = 0; j < 5; ++j) { await j; }'],
    ],
    [
      '() => { a; for (const bar of b) { c; } d; }',
      [
        '{ a; for (const bar of b) { c; } d; }',
        '{ a; for (const bar of b) { c; } d; } -> for (const bar of b) { c; }',
      ],
    ],
    ['other;for (const { bar } in foo) { i++; }', ['for (const { bar } in foo) { i++; }']],
    ['function foo(hello, world) {}', ['hello, world) {}']],
    ['`hello ${(() => {"world"})()}!`', ['{"world"}']],
  ];

  const calculateActual = (source: string, root: ScopeNode<void>): string[] => {
    const toOffset = new PositionToOffset(source);
    const actual: string[] = [];
    const gather = (node: ScopeNode<void>, context: string) => {
      const own = context
        + source.slice(toOffset.convert(node.range.begin), toOffset.convert(node.range.end));
      actual.push(own);
      node.children?.forEach(c => gather(c, own + ' -> '));
    };

    root.children?.forEach(node => gather(node, ''));
    return actual;
  };

  for (const [source, expected] of tcases) {
    it(source, async () => {
      const actual = calculateActual(
        source,
        await extractScopeRanges<void>(source, () => undefined),
      );
      expect(actual).to.deep.equal(expected);
    });
  }

  it('filterHoist', async () => {
    const src = [
      '() => {',
      /**/ 'function a() {',
      /*  */ 'function b() {',
      /*    */ 'function c(a) {}',
      /*    */ 'function c2(b) {}',
      /*  */ '}',
      /*  */ 'function b2() {}',
      /**/ '}',
      '}',
    ].join('\n');

    const tree = await extractScopeRanges<void>(src, () => undefined);
    tree.filterHoist(n => n.range.begin.base0.lineNumber % 2 === 0);
    const actual = calculateActual(src, tree);
    expect(actual).to.deep.equal([
      '{\nfunction a() {\nfunction b() {\nfunction c(a) {}\nfunction c2(b) {}\n}\nfunction b2() {}\n}\n}',
      '{\nfunction a() {\nfunction b() {\nfunction c(a) {}\nfunction c2(b) {}\n}\nfunction b2() {}\n}\n} -> {\nfunction c(a) {}\nfunction c2(b) {}\n}',
      '{\nfunction a() {\nfunction b() {\nfunction c(a) {}\nfunction c2(b) {}\n}\nfunction b2() {}\n}\n} -> {\nfunction c(a) {}\nfunction c2(b) {}\n} -> b) {}',
      '{\nfunction a() {\nfunction b() {\nfunction c(a) {}\nfunction c2(b) {}\n}\nfunction b2() {}\n}\n} -> {}',
    ]);
  });

  it('findDeepest', async () => {
    const src = [
      '() => {', // 1
      /**/ 'function a() {', // 2
      /*  */ 'function b() {', // 3
      /*    */ 'function c(a) {}', // 4
      /*    */ 'function c2(b) {}', // 5
      /*  */ '}',
      /*  */ 'function b2() {}', // 6
      /**/ '}',
      '}',
    ].join('\n');

    const tree = await extractScopeRanges<number>(src, () => undefined);
    let i = 0;
    tree.forEach(n => (n.data = i++));

    expect(tree.findDeepest(new Base0Position(3, 15), n => n)?.data).to.equal(4);
    expect(
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      tree.findDeepest(new Base0Position(3, 15), n => (n.data! % 2 === 1 ? n : undefined))?.data,
    ).to.equal(3);
  });
});
