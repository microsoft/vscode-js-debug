/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { expect } from 'chai';
import { stub } from 'sinon';
import Cdp from '../../cdp/api';
import Connection from '../../cdp/connection';
import { stubbedCdpApi } from '../../cdp/stubbedApi';
import { Logger } from '../../common/logging/logger';
import { upcastPartial } from '../../common/objUtils';
import {
  extensionHostConfigDefaults,
  nodeAttachConfigDefaults,
  nodeLaunchConfigDefaults,
} from '../../configuration';
import { NodeTarget } from './nodeTarget';

describe('NodeTarget', () => {
  for (
    const [name, config] of [
      ['Node launch', nodeLaunchConfigDefaults],
      ['Node attach', nodeAttachConfigDefaults],
      ['extension host', extensionHostConfigDefaults],
    ] as const
  ) {
    for (const autoAttachChildProcesses of [undefined, true, false]) {
      it(`respects autoAttachChildProcesses=${autoAttachChildProcesses} for ${name}`, async () => {
        const launchConfig = autoAttachChildProcesses === undefined
          ? config
          : { ...config, autoAttachChildProcesses };
        const cdp = stubbedCdpApi();
        cdp.Target.attachToTarget.resolves({ sessionId: 'session' });
        const api = upcastPartial<Cdp.Api>({
          pause: stub(),
          Target: cdp.actual.Target,
          Runtime: cdp.actual.Runtime,
          NodeWorker: cdp.actual.NodeWorker,
        });
        const target = new NodeTarget(
          launchConfig,
          { id: 'origin' },
          upcastPartial<Connection>({ onDisconnected: stub() }),
          api,
          {
            targetId: 'target',
            processId: 1,
            processInspectorPort: 9229,
            type: 'node',
            title: 'test.js',
            url: '',
            attached: false,
            canAccessOpener: false,
          },
          Logger.null,
          {},
          undefined,
        );

        expect(await target.attach()).to.equal(api);
        if (launchConfig.autoAttachChildProcesses) {
          expect(cdp.NodeWorker.enable.args).to.deep.equal([[{ waitForDebuggerOnStart: true }]]);
        } else {
          expect(cdp.NodeWorker.enable.called).to.be.false;
        }
      });
    }
  }
});
