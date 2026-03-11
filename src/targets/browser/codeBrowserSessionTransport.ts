/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import type * as vscode from 'vscode';
import { ITransport } from '../../cdp/transport';
import { EventEmitter } from '../../common/events';
import { HrTime } from '../../common/hrnow';

/**
 * A CDP transport that wraps a VS Code BrowserCDPSession.
 */
export class CodeBrowserSessionTransport implements ITransport {
  private readonly messageEmitter = new EventEmitter<[string, HrTime]>();
  private readonly endEmitter = new EventEmitter<void>();

  public readonly onMessage = this.messageEmitter.event;
  public readonly onEnd = this.endEmitter.event;

  constructor(private readonly session: vscode.BrowserCDPSession) {
    session.onDidReceiveMessage(msg => {
      this.messageEmitter.fire([typeof msg === 'string' ? msg : JSON.stringify(msg), new HrTime()]);
    });
    session.onDidClose(() => {
      this.endEmitter.fire();
    });
  }

  send(message: string): void {
    const parsed = JSON.parse(message);
    this.session.sendMessage(parsed);
  }

  dispose(): void {
    this.session.close();
  }
}
