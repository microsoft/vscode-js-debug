/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { EventEmitter } from '../../common/events';
import * as vscode from 'vscode';
import { DisposableList, IDisposable } from '../../common/disposable';
import { IProfilerCtor } from '../../adapter/profiling';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';

/**
 * UI-side tracker for profiling sessions.
 */
export class UiProfileSession implements IDisposable {
  private statusChangeEmitter = new EventEmitter<string>();
  private stopEmitter = new EventEmitter<void>();
  private _innerStatus?: string;
  private disposables = new DisposableList();

  /**
   * Event that fires when the status changes.
   */
  public readonly onStatusChange = this.statusChangeEmitter.event;

  /**
   * Event that fires when the session stops for any reason.
   */
  public readonly onStop = this.stopEmitter.event;

  /**
   * Gets the current session status.
   */
  public get status() {
    return this._innerStatus;
  }

  /**
   * Starts the session and returns its ui-side tracker.
   */
  public static async start(session: vscode.DebugSession, impl: IProfilerCtor) {
    const file = join(
      tmpdir(),
      `vscode-js-profile-${randomBytes(4).toString('hex')}${impl.extension}`,
    );

    try {
      await session.customRequest('startProfile', { file, type: impl.type });
    } catch (e) {
      vscode.window.showErrorMessage(e.message);
      return;
    }

    return new UiProfileSession(session, impl, file);
  }

  constructor(
    public readonly session: vscode.DebugSession,
    public readonly impl: IProfilerCtor,
    private readonly file: string,
  ) {
    this.disposables.push(
      vscode.debug.onDidReceiveDebugSessionCustomEvent(event => {
        if (event.session === session && event.event === 'profilerStateUpdate') {
          this.setStatus(event.body.label);
        }
      }),
      vscode.debug.onDidTerminateDebugSession(s => {
        if (s === session) {
          this.stopEmitter.fire(undefined);
        }
      }),
    );
  }

  /**
   * @inheritdoc
   */
  public dispose() {
    this.disposables.dispose();
  }

  /**
   * Stops the profile, and returns the file that profiling information was
   * saved in.
   */
  public async stop() {
    await this.session.customRequest('stopProfile', {});
    this.stopEmitter.fire();
    this.dispose();
    return this.file;
  }

  private setStatus(status: string) {
    this._innerStatus = status;
    this.statusChangeEmitter.fire(status);
  }
}
