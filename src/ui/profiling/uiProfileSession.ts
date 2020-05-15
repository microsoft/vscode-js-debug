/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { EventEmitter } from '../../common/events';
import * as vscode from 'vscode';
import { DisposableList, IDisposable } from '../../common/disposable';
import { IProfilerCtor } from '../../adapter/profiling';
import Dap from '../../dap/api';
import * as nls from 'vscode-nls';
import { ITerminationCondition } from './terminationCondition';

const localize = nls.loadMessageBundle();

const enum State {
  Collecting,
  Saving,
  Stopped,
}

export const enum Category {
  Overwrite = -1,
  Adapter,
  TerminationTimer,
}

/**
 * UI-side tracker for profiling sessions.
 */
export class UiProfileSession implements IDisposable {
  private statusChangeEmitter = new EventEmitter<string>();
  private stopEmitter = new EventEmitter<string | undefined>();
  private _innerStatus: string[] = [];
  private disposables = new DisposableList();
  private state = State.Collecting;
  private file?: string;

  /**
   * Event that fires when the status changes.
   */
  public readonly onStatusChange = this.statusChangeEmitter.event;

  /**
   * Event that fires when the session stops, containing the file that
   * the profile is saved in.
   */
  public readonly onStop = this.stopEmitter.event;

  /**
   * Gets the current session status.
   */
  public get status() {
    return this._innerStatus.filter(s => !!s).join(', ') || undefined;
  }

  constructor(
    public readonly session: vscode.DebugSession,
    public readonly impl: IProfilerCtor,
    private readonly termination: ITerminationCondition,
  ) {
    this.disposables.push(
      termination,
      vscode.debug.onDidReceiveDebugSessionCustomEvent(event => {
        if (event.session === session && event.event === 'profilerStateUpdate') {
          this.onStateUpdate(event.body);
        }
      }),
      vscode.debug.onDidTerminateDebugSession(s => {
        if (s === session) {
          this.stopEmitter.fire(undefined);
        }
      }),
    );

    termination.attachTo?.(this);
  }

  /**
   * Starts the session and returns its ui-side tracker.
   */
  public async start() {
    try {
      await this.session.customRequest('startProfile', {
        type: this.impl.type,
        ...this.termination.customData,
      });
    } catch (e) {
      vscode.window.showErrorMessage(e.message);
      this.stopEmitter.fire(undefined);
    }
  }

  /**
   * @inheritdoc
   */
  public dispose() {
    this.state = State.Stopped;
    this.disposables.dispose();
  }

  /**
   * Updates the file the profile is saved in.
   */
  public setFile(file: string) {
    this.file = file;
  }

  /**
   * Stops the profile, and returns the file that profiling information was
   * saved in.
   */
  public async stop() {
    if (this.state !== State.Collecting) {
      return;
    }

    this.setStatus(Category.Overwrite, localize('profile.saving', 'Saving'));
    this.state = State.Saving;
    await this.session.customRequest('stopProfile', {});
    // this will trigger a profileStateUpdate with running=false
    // to finish up the session.
  }

  public onStateUpdate(update: Dap.ProfilerStateUpdateEventParams) {
    if (update.running) {
      this.setStatus(Category.Adapter, update.label);
      return;
    }

    this.state = State.Stopped;
    this.stopEmitter.fire(this.file);
    this.dispose();
  }

  /**
   * Updates the session state, notifying the manager.
   */
  public setStatus(category: Category, status: string) {
    if (this.state !== State.Collecting) {
      return;
    }

    if (category === Category.Overwrite) {
      this._innerStatus = [status];
    } else {
      this._innerStatus[category] = status;
    }

    this.statusChangeEmitter.fire(this.status as string);
  }
}
