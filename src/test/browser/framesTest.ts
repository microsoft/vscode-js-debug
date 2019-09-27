// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { TestRoot } from '../test';
import { Target } from '../../targets/targets';

export function addTests(testRunner) {
  // @ts-ignore unused xit/fit variables.
  const { it, fit, xit, describe, fdescribe, xdescribe } = testRunner;

  it('hierarchy', async ({ r }: { r: TestRoot }) => {
    r.setArgs(['--site-per-process']);
    const p = await r.launchUrl('frames.html');
    p.load();

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
      r.onSessionCreated(() => {
        if (r.binder.targetList().length === 11)
          f();
      });
    });
    r.binder.targetList().filter(t => !t.parent()).forEach(target => logTarget(target, 0));

    p.assertLog();
  });
}
