/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as vscode from 'vscode';
import {
  ICustomBreakpoint,
  CustomBreakpointId,
  customBreakpoints,
} from '../adapter/customBreakpoints';
import { EventEmitter } from '../common/events';
import { DebugSessionTracker } from './debugSessionTracker';
import { Contributions, Commands } from '../common/contributionUtils';

class Breakpoint {
  id: CustomBreakpointId;
  label: string;
  enabled: boolean;
  treeItem: vscode.TreeItem;

  constructor(cb: ICustomBreakpoint, enabled: boolean) {
    this.id = cb.id;
    this.enabled = enabled;
    this.label = `${cb.group}: ${cb.title}`;
    this.treeItem = new vscode.TreeItem(this.label);
    this.treeItem.id = cb.id;
  }

  static compare(a: Breakpoint, b: Breakpoint) {
    return a.label.localeCompare(b.label);
  }
}

class BreakpointsDataProvider implements vscode.TreeDataProvider<Breakpoint> {
  private _onDidChangeTreeData = new EventEmitter<Breakpoint | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private _debugSessionTracker: DebugSessionTracker;

  breakpoints: Breakpoint[];

  constructor(debugSessionTracker: DebugSessionTracker) {
    this.breakpoints = [];
    for (const cb of customBreakpoints().values()) this.breakpoints.push(new Breakpoint(cb, false));

    this._debugSessionTracker = debugSessionTracker;
    debugSessionTracker.onSessionAdded(session => {
      session.customRequest('enableCustomBreakpoints', {
        ids: this.breakpoints.filter(b => b.enabled).map(b => b.id),
      });
    });
  }

  getTreeItem(item: Breakpoint): vscode.TreeItem {
    return item.treeItem;
  }

  async getChildren(item?: Breakpoint): Promise<Breakpoint[]> {
    if (!item) return this.breakpoints.filter(b => b.enabled).sort(Breakpoint.compare);
    return [];
  }

  async getParent(): Promise<Breakpoint | undefined> {
    return undefined;
  }

  addBreakpoints(breakpoints: Breakpoint[]) {
    for (const breakpoint of breakpoints) breakpoint.enabled = true;
    const ids = breakpoints.map(b => b.id);
    for (const session of this._debugSessionTracker.sessions.values())
      session.customRequest('enableCustomBreakpoints', { ids });
    this._onDidChangeTreeData.fire(undefined);
  }

  removeBreakpoints(breakpointIds: CustomBreakpointId[]) {
    const ids = new Set(breakpointIds);
    for (const breakpoint of this.breakpoints) {
      if (ids.has(breakpoint.id)) breakpoint.enabled = false;
    }
    for (const session of this._debugSessionTracker.sessions.values())
      session.customRequest('disableCustomBreakpoints', { ids: breakpointIds });
    this._onDidChangeTreeData.fire(undefined);
  }
}

export function registerCustomBreakpointsUI(
  context: vscode.ExtensionContext,
  debugSessionTracker: DebugSessionTracker,
) {
  const provider = new BreakpointsDataProvider(debugSessionTracker);

  vscode.window.createTreeView(Contributions.BrowserBreakpointsView, {
    treeDataProvider: provider,
  });
  context.subscriptions.push(
    vscode.commands.registerCommand(Commands.AddCustomBreakpoints, () => {
      const quickPick = vscode.window.createQuickPick();
      const items = provider.breakpoints.filter(b => !b.enabled);
      quickPick.items = items;
      quickPick.onDidAccept(() => {
        provider.addBreakpoints(quickPick.selectedItems as Breakpoint[]);
        quickPick.dispose();
      });
      quickPick.show();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(Commands.RemoveAllCustomBreakpoints, () => {
      provider.removeBreakpoints(provider.breakpoints.filter(b => b.enabled).map(b => b.id));
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      Commands.RemoveCustomBreakpoint,
      (treeItem: vscode.TreeItem) => {
        provider.removeBreakpoints([treeItem.id as string]);
      },
    ),
  );
}
