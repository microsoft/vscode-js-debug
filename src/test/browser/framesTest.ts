// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { TestP } from '../test';
import { Target } from '../../adapter/targets';

export function addTests(testRunner) {
  // @ts-ignore unused xit/fit variables.
  const { it, fit, xit, describe, fdescribe, xdescribe } = testRunner;

  it('hierarchy', async ({ p }: { p: TestP }) => {
    p.setArgs(['--site-per-process']);
    await p.launchUrl('frames.html');

    const logTarget = (t: Target, indent: number) => {
      const s = ' '.repeat(indent);
      const thread = t.thread ? ' [thread "' + t.thread.baseUrlForTest() + '"]' : '';
      p.log(`${s}${t.type} "${t.name}"${thread}${t.fileName ? ' @ ' + t.fileName : ''}`);
      t.children.forEach(child => logTarget(child, indent + 2));
    };

    await new Promise(callback => {
      const disposables = [];
      p.adapter.onTargetForestChanged(() => {
        let count = 0;
        const visit = (t: Target) => {
          ++count;
          t.children.forEach(visit);
        };
        p.adapter.targetForest().forEach(visit);
        if (count === 14) {
          (disposables[0] as any).dispose();
          callback();
        }
      }, undefined, disposables);
    });

    p.adapter.targetForest().forEach(target => logTarget(target, 0));

    p.assertLog();
  });
}
