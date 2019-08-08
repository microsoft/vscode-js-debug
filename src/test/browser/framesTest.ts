// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { TestP } from '../test';
import { Target } from '../../targets/targets';

export function addTests(testRunner) {
  // @ts-ignore unused xit/fit variables.
  const { it, fit, xit, describe, fdescribe, xdescribe } = testRunner;

  it('hierarchy', async ({ p }: { p: TestP }) => {
    p.setArgs(['--site-per-process']);
    p.launchUrl('frames.html');

    const logTarget = (t: Target, indent: number) => {
      const s = ' '.repeat(indent);
      p.log(`${s}${t.type()} "${t.name()}" [thread "${t.scriptUrlToUrl('')}"]${t.fileName() ? ' @ ' + t.fileName() : ''}`);
      const children = t.children();
      children.sort((t1, t2) => {
        return t1.name().localeCompare(t2.name());
      });
      children.forEach(child => logTarget(child, indent + 2));
    };

    await new Promise(f => {
      p.adapter.threadManager.onThreadAdded(() => {
        if (p.adapter.threadManager.threads().length === 11)
          f();
      });
    });
    p.binder.targetList().filter(t => !t.parent()).forEach(target => logTarget(target, 0));

    p.assertLog();
  });
}
