/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as vscode from 'vscode';
import { DisposableList, IDisposable } from '../common/disposable';

/**
 * Simple tracker class that allows up to one Tunnel per debug session,
 * and disposes the tunnels when the session ends.
 */
export class DebugSessionTunnels implements IDisposable {
  private readonly tunnels = new Map<string, vscode.Tunnel>();
  private readonly disposable = new DisposableList();

  constructor() {
    this.disposable.push(
      vscode.debug.onDidTerminateDebugSession(session => this.destroySession(session.id)),
    );
  }

  /**
   * @inheritdoc
   */
  public dispose() {
    return this.disposable.dispose();
  }

  /**
   * Removes a session tunnel if it exists.
   */
  public destroySession(sessionId: string) {
    const tunnel = this.tunnels.get(sessionId);
    if (tunnel) {
      tunnel.dispose();
      this.tunnels.delete(sessionId);
    }
  }

  /**
   * Requests a tunnel. Note that if a tunnel was previously created for the
   * session, it'll be returned regardless of the localPort/remotePort.
   */
  public async request(
    sessionId: string,
    opts: {
      label: string;
      localPort?: number;
      remotePort: number;
    },
  ) {
    let tunnel = this.tunnels.get(sessionId);
    if (!tunnel) {
      tunnel = await vscode.workspace.openTunnel({
        remoteAddress: { port: opts.remotePort, host: 'localhost' },
        localAddressPort: opts.localPort ?? opts.remotePort,
        label: opts.label,
      });
      this.tunnels.set(sessionId, tunnel);
    }

    let localAddress: { host: string; port: number };
    if (typeof tunnel.localAddress === 'string') {
      const [host, port] = tunnel.localAddress.split(':');
      localAddress = { host, port: Number(port) };
    } else {
      localAddress = tunnel.localAddress;
    }

    return {
      remoteAddress: tunnel.remoteAddress,
      localAddress,
    };
  }
}
