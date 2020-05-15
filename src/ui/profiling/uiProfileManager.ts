/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as vscode from 'vscode';
import * as nls from 'vscode-nls';
import { DebugSessionTracker } from '../debugSessionTracker';
import { injectable, inject, multiInject } from 'inversify';
import { ProfilerFactory } from '../../adapter/profiling';
import { AnyLaunchConfiguration } from '../../configuration';
import { UiProfileSession } from './uiProfileSession';
import { Commands } from '../../common/contributionUtils';
import { basename, join } from 'path';
import { FS, FsPromises, SessionSubStates } from '../../ioc-extras';
import { IDisposable, DisposableList } from '../../common/disposable';
import { ITerminationConditionFactory } from './terminationCondition';
import { homedir } from 'os';
import { moveFile } from '../../common/fsUtils';
import Dap from '../../dap/api';
import { ManualTerminationCondition } from './manualTerminationCondition';

const localize = nls.loadMessageBundle();

const isProfileCandidate = (session: vscode.DebugSession) =>
  '__pendingTargetId' in session.configuration;

/**
 * Arguments provided in the `startProfile` command.
 */
export interface IStartProfileArguments {
  /**
   * Session ID to capture. If not provided, the user may be asked to pick
   * an available session.
   */
  sessionId?: string;
  /**
   * Type of profile to take. One of the "IProfiler.type" types. Currently,
   * only 'cpu' is available. If not provided, the user will be asked to pick.
   */
  type?: string;
  /**
   * Termination condition. If not provided, the user will be asked to pick.
   * Optionally pass arguments:
   *  - `manual` takes no arguments
   *  - `duration` takes a [number] of seconds
   *  - `breakpoint` takes a `[Array<number>]` of DAP breakpoint IDs. These can
   *    be found by calling the custom `getBreakpoints` method on a debug session.
   */
  termination?: string | { type: string; args?: ReadonlyArray<unknown> };

  /**
   * Command to run when the profile has completed. If not provided, the
   * profile will be opened in a new untitled editor. The command will receive
   * an `IProfileCallbackArguments` object.
   */
  onCompleteCommand?: string;
}

/**
 * Arguments given to the `onCompleteCommand`.
 */
export interface IProfileCallbackArguments {
  /**
   * String contents of the profile.
   */
  contents: string;

  /**
   * Suggested file name of the profile.
   */
  basename: string;
}

@injectable()
export class UiProfileManager implements IDisposable {
  private statusBarItem?: vscode.StatusBarItem;
  private lastChosenType: string | undefined;
  private lastChosenTermination: string | undefined;
  private readonly activeSessions = new Map<string /* debug session id */, UiProfileSession>();
  private readonly disposables = new DisposableList();

  constructor(
    @inject(DebugSessionTracker) private readonly tracker: DebugSessionTracker,
    @inject(FS) private readonly fs: FsPromises,
    @inject(SessionSubStates) private readonly sessionStates: SessionSubStates,
    @multiInject(ITerminationConditionFactory)
    private readonly terminationConditions: ReadonlyArray<ITerminationConditionFactory>,
  ) {
    this.disposables.push(
      vscode.debug.onDidReceiveDebugSessionCustomEvent(event => {
        if (event.event !== 'profileStarted') {
          return;
        }

        const args = event.body as Dap.ProfileStartedEventParams;
        let session = this.activeSessions.get(event.session.id);
        if (!session) {
          session = new UiProfileSession(
            event.session,
            ProfilerFactory.ctors.find(t => t.type === args.type) || ProfilerFactory.ctors[0],
            new ManualTerminationCondition(),
          );
          this.registerSession(session);
        }

        session.setFile(args.file);
      }),
    );
  }

  /**
   * Starts a profiling session.
   */
  public async start(args: IStartProfileArguments) {
    let maybeSession: vscode.DebugSession | undefined;
    const candidates = [...this.tracker.sessions.values()].filter(isProfileCandidate);
    if (args.sessionId) {
      maybeSession = candidates.find(s => s.id === args.sessionId);
    } else {
      maybeSession = await this.pickSession(candidates);
    }

    if (!maybeSession) {
      return; // cancelled or invalid
    }

    const session = maybeSession;
    const existing = this.activeSessions.get(session.id);
    if (existing) {
      if (!(await this.alreadyRunningSession(existing))) {
        return;
      }
    }

    const impl = await this.pickType(session, args.type);
    if (!impl) {
      return;
    }

    const termination = await this.pickTermination(session, args.termination);
    if (!termination) {
      return;
    }

    const uiSession = new UiProfileSession(session, impl, termination);
    if (!uiSession) {
      return;
    }

    this.registerSession(uiSession, args.onCompleteCommand);
    await uiSession.start();
  }

  /**
   * Stops the profiling session if it exists.
   */
  public async stop(sessionId?: string) {
    let uiSession: UiProfileSession | undefined;
    if (sessionId) {
      uiSession = this.activeSessions.get(sessionId);
    } else {
      const session = await this.pickSession([...this.activeSessions.values()].map(s => s.session));
      uiSession = session && this.activeSessions.get(session.id);
    }

    if (!uiSession) {
      return;
    }

    this.sessionStates.remove(uiSession.session.id);
    await uiSession.stop();
  }

  /**
   * @inheritdoc
   */
  public dispose() {
    for (const session of this.activeSessions.values()) {
      session.dispose();
    }

    this.activeSessions.clear();
    this.disposables.dispose();
  }

  /**
   * Starts tracking a UI profile session in the manager.
   */
  private registerSession(uiSession: UiProfileSession, onCompleteCommand?: string) {
    this.activeSessions.set(uiSession.session.id, uiSession);
    this.sessionStates.add(uiSession.session.id, localize('profile.sessionState', 'Profiling'));
    uiSession.onStatusChange(() => this.updateStatusBar());
    uiSession.onStop(file => {
      if (file) {
        this.openProfileFile(uiSession, onCompleteCommand, uiSession.session, file);
      }

      this.activeSessions.delete(uiSession.session.id);
      uiSession.dispose();
      this.updateStatusBar();
    });
    this.updateStatusBar();
  }

  /**
   * Opens the profile file within the UI, called
   * when a session ends gracefully.
   */
  private async openProfileFile(
    uiSession: UiProfileSession,
    onCompleteCommand: string | undefined,
    session: vscode.DebugSession,
    sourceFile: string,
  ) {
    if (onCompleteCommand) {
      return Promise.all([
        vscode.commands.executeCommand(onCompleteCommand, {
          contents: await this.fs.readFile(sourceFile, 'utf-8'),
          basename: basename(sourceFile) + uiSession.impl.extension,
        } as IProfileCallbackArguments),
        this.fs.unlink(sourceFile),
      ]);
    }

    const directory =
      session.workspaceFolder?.uri.fsPath ??
      vscode.workspace.workspaceFolders?.[0].uri.fsPath ??
      homedir();

    const now = new Date();
    const filename =
      [
        'vscode-profile',
        now.getFullYear(),
        now.getMonth() + 1,
        now.getDate(),
        now.getHours(),
        now.getMinutes(),
        now.getSeconds(),
      ]
        .map(n => String(n).padStart(2, '0'))
        .join('-') + uiSession.impl.extension;

    // todo: open as untitled, see: https://github.com/microsoft/vscode/issues/93441
    const fileUri = vscode.Uri.file(join(directory, filename));
    await moveFile(this.fs, sourceFile, fileUri.fsPath);

    await vscode.commands.executeCommand('vscode.open', fileUri);
  }

  /**
   * Updates the status bar based on the state of current debug sessions.
   */
  private updateStatusBar() {
    if (this.activeSessions.size === 0) {
      this.statusBarItem?.hide();
      vscode.commands.executeCommand('setContext', 'jsDebugIsProfiling', false);
      return;
    }

    if (!this.statusBarItem) {
      this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 500);
      this.statusBarItem.command = Commands.StopProfile;
    }

    vscode.commands.executeCommand('setContext', 'jsDebugIsProfiling', true);

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
  private async pickType(session: vscode.DebugSession, suggestedType?: string) {
    const params = session.configuration as AnyLaunchConfiguration;
    if (suggestedType) {
      return ProfilerFactory.ctors.find(t => t.type === suggestedType && t.canApplyTo(params));
    }

    const chosen = await this.pickWithLastDefault(
      localize('profile.type.title', 'Type of profile:'),
      ProfilerFactory.ctors.filter(ctor => ctor.canApplyTo(params)),
      this.lastChosenType,
    );
    if (chosen) {
      this.lastChosenType = chosen.label;
    }

    return chosen;
  }

  /**
   * Picks the termination condition to use for the session.
   */
  private async pickTermination(
    session: vscode.DebugSession,
    suggested: IStartProfileArguments['termination'],
  ) {
    if (suggested) {
      const s = typeof suggested === 'string' ? { type: suggested } : suggested;
      return this.terminationConditions
        .find(t => t.id === s.type)
        ?.onPick(session, ...(s.args ?? []));
    }

    const chosen = await this.pickWithLastDefault(
      localize('profile.termination.title', 'How long to run the profile:'),
      this.terminationConditions,
      this.lastChosenTermination,
    );
    if (chosen) {
      this.lastChosenTermination = chosen.label;
    }

    return chosen?.onPick(session);
  }

  private async pickWithLastDefault<
    T extends { label: string; description?: string; sortOrder?: number }
  >(title: string, items: ReadonlyArray<T>, lastLabel?: string): Promise<T | undefined> {
    if (items.length <= 1) {
      return items[0]; // first T or undefined
    }

    const quickpick = vscode.window.createQuickPick();
    quickpick.title = title;
    quickpick.items = items
      .slice()
      .sort((a, b) => {
        if (a.label === lastLabel || b.label === lastLabel) {
          return a.label === lastLabel ? -1 : 1;
        }

        return (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
      })
      .map(ctor => ({ label: ctor.label, description: ctor.description, alwaysShow: true }));

    const chosen = await new Promise<string | undefined>(resolve => {
      quickpick.onDidAccept(() => resolve(quickpick.selectedItems[0]?.label));
      quickpick.onDidHide(() => resolve());
      quickpick.show();
    });

    quickpick.dispose();

    if (!chosen) {
      return;
    }

    return items.find(c => c.label === chosen);
  }
}
