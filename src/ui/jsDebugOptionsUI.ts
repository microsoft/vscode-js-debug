/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { inject, injectable } from 'inversify';
import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { ContextKey, CustomViews, setContextKey } from '../common/contributionUtils';
import { DisposableList } from '../common/disposable';
import Dap from '../dap/api';
import { IExtensionContribution } from '../ioc-extras';
import { DebugSessionTracker } from './debugSessionTracker';

const focusEmulationStorageKey = 'jsDebug.focusEmulation.enabled';

class FocusEmulationOption extends vscode.TreeItem {
  constructor(enabled: boolean) {
    super(l10n.t('Emulate a focused page'), vscode.TreeItemCollapsibleState.None);
    this.checkboxState = enabled
      ? vscode.TreeItemCheckboxState.Checked
      : vscode.TreeItemCheckboxState.Unchecked;
    this.tooltip = l10n.t(
      'When enabled, the debugged page will behave as if it has focus',
    );
    this.id = 'focusEmulation';
  }
}

type DebugOptionItem = FocusEmulationOption;

@injectable()
export class JsDebugOptionsUI
  implements IExtensionContribution, vscode.TreeDataProvider<DebugOptionItem>
{
  private readonly _disposables = new DisposableList();
  private readonly _treeDataChangeEmitter = new vscode.EventEmitter<DebugOptionItem | undefined>();
  private readonly _supportedSessions = new Set<string>();
  private _focusEmulationEnabled = false;

  readonly onDidChangeTreeData = this._treeDataChangeEmitter.event;

  constructor(
    @inject(DebugSessionTracker) private readonly _debugSessionTracker: DebugSessionTracker,
  ) {}

  register(context: vscode.ExtensionContext): void {
    this._focusEmulationEnabled = context.workspaceState.get(focusEmulationStorageKey, false);

    const view = vscode.window.createTreeView(CustomViews.DebugOptions, {
      treeDataProvider: this,
      manageCheckboxStateManually: true,
    });

    this._disposables.push(
      view,
      view.onDidChangeCheckboxState(e => {
        for (const [item, state] of e.items) {
          if (item instanceof FocusEmulationOption) {
            const enabled = state === vscode.TreeItemCheckboxState.Checked;
            this._focusEmulationEnabled = enabled;
            context.workspaceState.update(focusEmulationStorageKey, enabled);
            this._applyFocusEmulationToAllSessions();
            this._treeDataChangeEmitter.fire(undefined);
          }
        }
      }),
      this._debugSessionTracker.onSessionAdded(session => {
        this._checkEmulationSupport(session);
      }),
      this._debugSessionTracker.onSessionEnded(session => {
        this._supportedSessions.delete(session.id);
        this._updateContextKey();
      }),
    );

    context.subscriptions.push(this._disposables);
  }

  getTreeItem(element: DebugOptionItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: DebugOptionItem): vscode.ProviderResult<DebugOptionItem[]> {
    if (element) {
      return [];
    }
    return [new FocusEmulationOption(this._focusEmulationEnabled)];
  }

  private async _checkEmulationSupport(session: vscode.DebugSession): Promise<void> {
    try {
      const result: Dap.CanEmulateResult = await session.customRequest('canEmulate', {});

      if (result.supported) {
        this._supportedSessions.add(session.id);
        this._updateContextKey();

        // Apply current state if enabled
        if (this._focusEmulationEnabled) {
          session.customRequest('setFocusEmulation', { enabled: true });
        }
      }
    } catch {
      // Session doesn't support emulation, ignore
    }
  }

  private _applyFocusEmulationToAllSessions(): void {
    for (const sessionId of this._supportedSessions) {
      const session = this._debugSessionTracker.getById(sessionId);
      if (session) {
        session.customRequest('setFocusEmulation', { enabled: this._focusEmulationEnabled });
      }
    }
  }

  private _updateContextKey(): void {
    setContextKey(
      vscode.commands,
      ContextKey.DebugOptionsAvailable,
      this._supportedSessions.size > 0,
    );
  }
}
