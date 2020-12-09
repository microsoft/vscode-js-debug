/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { BrowserTarget } from '../../targets/browser/browserTargets';
import { itIntegrates } from '../testIntegrationUtils';

describe('frames', () => {
  itIntegrates('hierarchy', async ({ r }) => {
    r.setArgs(['--site-per-process']);
    const p = await r.launchUrl('frames.html');
    p.load();

    const logTarget = (t: BrowserTarget, indent: number) => {
      const s = ' '.repeat(indent);
      p.log(
        `${s}${t.type()} "${t.name()}" [thread "${t.scriptUrlToUrl('')}"]${
          t.fileName() ? ' @ ' + t.fileName() : ''
        }`,
      );
      const children = t.children();
      children.sort((t1, t2) => {
        return t1.name().localeCompare(t2.name());
      });
      children.forEach(child => logTarget(child as BrowserTarget, indent + 2));
    };

    await new Promise<void>(f => {
      r.onSessionCreated(() => {
        if (r.binder.targetList().length === 11) f();
      });
    });
    r.binder
      .targetList()
      .filter(t => !t.parent())
      .forEach(target => logTarget(target as BrowserTarget, 0));

    p.assertLog();
  });
});
