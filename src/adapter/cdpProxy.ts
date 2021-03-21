/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { Disposable } from 'vscode';
import WebSocket from 'ws';
import { Cdp } from '../cdp/api';

export class CDPProxy implements Disposable {
  private webSocket: WebSocket.Server | undefined;

  async proxy(_cdp: Cdp.Api): Promise<void> {
    if (!this.webSocket) {
      this.webSocket = new WebSocket.Server({ port: 0 });
    }
  }

  address(): { address: string; port: number; family: string } | undefined {
    const address = this.webSocket?.address();
    if (address && typeof address !== 'string') {
      return address;
    }
    return undefined;
  }

  dispose(): void {
    if (this.webSocket) {
      this.webSocket.close();
    }
  }
}
