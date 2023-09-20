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
        if (vscode.env.remoteName !== undefined) {
          const tunneled = await tunnels.request(sessionId, {
            label: 'Edge Devtools Tunnel',
            remotePort: proxied.port,
          });

          return {
            host: tunneled.localAddress.host,
            port: tunneled.localAddress.port,
            path: proxied.path,
          };
        }
      } catch {
        // fall through
      }

      return proxied;
    }),
  );
};
