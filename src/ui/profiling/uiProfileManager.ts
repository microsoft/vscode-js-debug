/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as vscode from 'vscode';
import * as nls from 'vscode-nls';
import { DebugSessionTracker } from '../debugSessionTracker';
import { injectable, inject } from 'inversify';
import { ProfilerFactory } from '../../adapter/profiling';
import { AnyLaunchConfiguration } from '../../configuration';
import { UiProfileSession } from './uiProfileSession';
import { Contributions } from '../../common/contributionUtils';
import { basename } from 'path';
import { FS, FsPromises } from '../../ioc-extras';
import { IDisposable } from '../../common/disposable';

const localize = nls.loadMessageBundle();

const isProfileCandidate = (session: vscode.DebugSession) =>
  '__pendingTargetId' in session.configuration;

@injectable()
export class UiProfileManager implements IDisposable {
  private statusBarItem?: vscode.StatusBarItem;
  private readonly activeSessions = new Set<UiProfileSession>();

  constructor(
    @inject(DebugSessionTracker) private readonly tracker: DebugSessionTracker,
    @inject(FS) private readonly fs: FsPromises,
  ) {}

  /**
   * Starts a profiling session.
   */
  public async start(sessionId?: string) {
    let session: vscode.DebugSession | undefined;
    const candidates = [...this.tracker.sessions.values()].filter(isProfileCandidate);
    if (sessionId) {
      session = candidates.find(s => s.id === sessionId);
    } else {
      session = await this.pickSession(candidates);
    }

    if (!session) {
      return; // cancelled or invalid
    }

    const existing = [...this.activeSessions].find(s => s.session === session);
    if (existing) {
      if (!(await this.alreadyRunningSession(existing))) {
        return;
      }
    }

    const impl = await this.pickType(session);
    if (!impl) {
      return;
    }

    const uiSession = await UiProfileSession.start(session, impl);
    if (!uiSession) {
      return;
    }

    this.activeSessions.add(uiSession);
    uiSession.onStatusChange(() => this.updateStatusBar());
    uiSession.onStop(() => {
      this.activeSessions.delete(uiSession);
      this.updateStatusBar();
    });
    this.updateStatusBar();
  }

  /**
   * Stops the profiling session if it exists.
   */
  public async stop(sessionId?: string) {
    let session: vscode.DebugSession | undefined;
    if (sessionId) {
      session = [...this.activeSessions].find(s => s.session.id === sessionId)?.session;
    } else {
      session = await this.pickSession([...this.activeSessions].map(s => s.session));
    }

    if (!session) {
      return;
    }

    const uiSession = [...this.activeSessions].find(s => s.session === session);
    if (!uiSession) {
      return;
    }

    const sourceFile = await uiSession.stop();
    if (!sourceFile) {
      return;
    }

    const targetFile = await vscode.window.showSaveDialog({
      defaultUri: session.workspaceFolder?.uri.with({
        path: session.workspaceFolder.uri.path + '/' + basename(sourceFile),
      }),
      filters: {
        [uiSession.impl.label]: [uiSession.impl.extension.slice(1)],
      },
    });

    if (targetFile) {
      this.fs.rename(sourceFile, targetFile.fsPath);
    }
  }

  /**
   * @inheritdoc
   */
  public dispose() {
    for (const session of this.activeSessions) {
      session.dispose();
    }

    this.activeSessions.clear();
  }

  /**
   * Updates the status bar based on the state of current debug sessions.
   */
  private updateStatusBar() {
    if (this.activeSessions.size === 0) {
      this.statusBarItem?.hide();
      return;
    }

    if (!this.statusBarItem) {
      this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 500);
      this.statusBarItem.command = Contributions.StopProfileCommand;
    }

    if (this.activeSessions.size === 1) {
      const session: UiProfileSession = this.activeSessions.values().next().value;
      this.statusBarItem.text = session.status
        ? localize(
            'profile.status.single',
            '$(loading) Click to Stop Profiling ({0})',
            session.status,
          )
        : localize('profile.status.default', '$(loading) Click to Stop Profiling');
    } else {
      this.statusBarItem.text = localize(
        'profile.status.multiSession',
        '$(loading) Click to Stop Profiling ({0} sessions)',
        this.activeSessions.size,
      );
    }

    this.statusBarItem.show();
  }

  /**
   * Triggered when we try to profile a session we're already profiling. Asks
   * if they want to stop and start profiling it again.
   */
  private async alreadyRunningSession(existing: UiProfileSession) {
    const yes = localize('yes', 'Yes');
    const no = localize('no', 'No');
    const stopExisting = await vscode.window.showErrorMessage(
      localize(
        'profile.alreadyRunning',
        'A profiling session is already running, would you like to stop it and start a new session?',
      ),
      yes,
      no,
    );

    if (stopExisting !== yes) {
      return false;
    }

    await this.stop(existing.session.id);
    return true;
  }

  /**
   * Quickpick to select any of the given candidate sessions.
   */
  private async pickSession(candidates: ReadonlyArray<vscode.DebugSession>) {
    if (candidates.length === 0) {
      return;
    }

    if (candidates.length === 1) {
      return candidates[0];
    }

    const chosen = await vscode.window.showQuickPick(
      candidates.map(c => ({ label: c.name, id: c.id })),
    );
    return chosen && candidates.find(c => c.id === chosen.id);
  }

  /**
   * Picks the profiler type to run in the session.
   */
  private async pickType(session: vscode.DebugSession) {
    const params = session.configuration as AnyLaunchConfiguration;
    const chosen = await vscode.window.showQuickPick(
      ProfilerFactory.ctors
        .filter(ctor => ctor.canApplyTo(params))
        .map(ctor => ({ type: ctor.type, label: ctor.label, description: ctor.description })),
    );

    return chosen && ProfilerFactory.ctors.find(c => c.type === chosen.type);
  }
}
