/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as vscode from 'vscode';
import { Commands, registerCommand } from '../common/contributionUtils';
import Dap from '../dap/api';
import { DebugSessionTracker } from './debugSessionTracker';
import { DebugSessionTunnels } from './debugSessionTunnels';

export const registerRequestCDPProxy = (
  context: vscode.ExtensionContext,
  tracker: DebugSessionTracker,
) => {
  const tunnels = new DebugSessionTunnels();

  context.subscriptions.push(
    tunnels,
    registerCommand(vscode.commands, Commands.RequestCDPProxy, async (sessionId, forwardToUi) => {
      const session = tracker.getById(sessionId);
      if (!session) {
        return undefined;
      }

      const proxied: Dap.RequestCDPProxyResult = await session.customRequest('requestCDPProxy');
      if (!forwardToUi) {
        return proxied;
      }

      try {
        const tunneled = await tunnels.request(sessionId, {
          label: 'Edge Devtools Tunnel',
          localPort: proxied.port,
        });

        return {
          host: tunneled.remoteAddress.host,
          port: tunneled.remoteAddress.port,
          path: proxied.path,
        };
      } catch {
        return proxied;
      }
    }),
  );
};
