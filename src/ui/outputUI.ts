/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as vscode from 'vscode';
import { AdapterFactory } from '../adapterFactory';
import * as stringUtils from '../utils/stringUtils';
import { Thread } from '../adapter/threads';
import { DebugAdapter } from '../adapter/debugAdapter';

export class OutputUI {
  constructor(context: vscode.ExtensionContext, factory: AdapterFactory) {
    factory.adapters().forEach(adapter => this._install(adapter));
    factory.onAdapterAdded(adapter => this._install(adapter))
  }

  _install(adapter: DebugAdapter): void {
    adapter.threadManager().threads().forEach(thread => new LazyLogger(thread));
    adapter.threadManager().onThreadAdded(thread => new LazyLogger(thread));
  }
}

class LazyLogger {
  private _thread: Thread;
  private _output: vscode.OutputChannel | undefined;

  constructor(thread: Thread) {
    this._thread = thread;
    thread.threadLog.lines().forEach(line => this._logLine(line));
    thread.threadLog.onLineAdded(line => this._logLine(line));
  }

  _logLine(line: string) {
    if (!this._output) {
      const outputName = `PWA [${stringUtils.formatMillisForLog(Date.now())}] ${this._thread.name()}`;
      this._output = vscode.window.createOutputChannel(outputName);
    }
    this._output.appendLine(line);
  }
}