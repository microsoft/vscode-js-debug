/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { IXHRBreakpoint } from '../adapter/XHRBreakpoints';
import { Commands, CustomViews } from '../common/contributionUtils';
import { EventEmitter } from '../common/events';
import { DebugSessionTracker } from './debugSessionTracker';

class XHRBreakpoint extends vscode.TreeItem {
  match: string;

  constructor(xhr: IXHRBreakpoint, enabled: boolean) {
    super(
      xhr.match ? l10n.t('URL contains "{0}"', xhr.match) : l10n.t('Any XHR or fetch'),
      vscode.TreeItemCollapsibleState.None,
    );
    this.id = xhr.match;
    this.match = xhr.match;
    this.checkboxState = enabled
      ? vscode.TreeItemCheckboxState.Checked
      : vscode.TreeItemCheckboxState.Unchecked;
  }

  static compare(a: XHRBreakpoint, b: XHRBreakpoint) {
    return a.match.localeCompare(b.match);
  }
}

class XHRBreakpointsDataProvider implements vscode.TreeDataProvider<XHRBreakpoint> {
  private _onDidChangeTreeData = new EventEmitter<XHRBreakpoint | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private _debugSessionTracker: DebugSessionTracker;

  xhrBreakpoints: XHRBreakpoint[];

  constructor(debugSessionTracker: DebugSessionTracker) {
    this.xhrBreakpoints = [];

    this._debugSessionTracker = debugSessionTracker;
    debugSessionTracker.onSessionAdded(session => {
      if (!DebugSessionTracker.isConcreteSession(session)) {
        return;
      }

      session.customRequest('enableXHRBreakpoints', {
        ids: this.xhrBreakpoints.filter(b => b.checkboxState).map(b => b.id),
      });
    });
  }

  getTreeItem(item: XHRBreakpoint): vscode.TreeItem {
    return item;
  }

  async getChildren(item?: XHRBreakpoint): Promise<XHRBreakpoint[]> {
    if (!item) return this.xhrBreakpoints.sort(XHRBreakpoint.compare);
    return [];
  }

  async getParent(): Promise<XHRBreakpoint | undefined> {
    return undefined;
  }

  addBreakpoints(breakpoints: XHRBreakpoint[]) {
    // filter out duplicates
    breakpoints = breakpoints.filter(b => !this.xhrBreakpoints.map(e => e.id).includes(b.id));
    const match = breakpoints.map(b => b.match);
    for (const breakpoint of breakpoints) this.xhrBreakpoints.push(breakpoint);
    for (const session of this._debugSessionTracker.getConcreteSessions())
      session.customRequest('enableXHRBreakpoints', { ids: match });
    this._onDidChangeTreeData.fire(undefined);
  }

  removeBreakpoints(breakpoints: XHRBreakpoint[]) {
    const breakpointIds = breakpoints.map(b => b.id);

    this.xhrBreakpoints = this.xhrBreakpoints.filter(b => !breakpointIds.includes(b.id));

    for (const session of this._debugSessionTracker.getConcreteSessions())
      session.customRequest('disableXHRBreakpoints', { ids: breakpointIds });
    this._onDidChangeTreeData.fire(undefined);
  }
}

export function registerXHRBreakpointsUI(
  context: vscode.ExtensionContext,
  debugSessionTracker: DebugSessionTracker,
) {
  const provider = new XHRBreakpointsDataProvider(debugSessionTracker);

  const view = vscode.window.createTreeView(CustomViews.XHRFetchBreakpoints, {
    treeDataProvider: provider,
  });

  view.onDidChangeCheckboxState(e => {
    for (const session of debugSessionTracker.getConcreteSessions())
      session.customRequest(`${e.items[0][1] ? 'enable' : 'disable'}XHRBreakpoints`, {
        ids: [e.items[0][0].id],
      });
  }, debugSessionTracker);
  context.subscriptions.push(view);

  context.subscriptions.push(
    vscode.commands.registerCommand(Commands.AddXHRBreakpoints, () => {
      const inputBox = vscode.window.createInputBox();
      inputBox.title = 'Add XHR Breakpoint';
      inputBox.placeholder = 'Enter a URL or a pattern to match';
      inputBox.onDidAccept(() => {
        const match = inputBox.value;
        provider.addBreakpoints([new XHRBreakpoint({ match }, true)]);
        inputBox.dispose();
      });
      inputBox.show();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(Commands.RemoveAllXHRBreakpoints, () => {
      provider.removeBreakpoints(provider.xhrBreakpoints);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(Commands.RemoveXHRBreakpoints, (treeItem: vscode.TreeItem) => {
      provider.removeBreakpoints([treeItem as XHRBreakpoint]);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(Commands.EditXHRBreakpoint, (treeItem: vscode.TreeItem) => {
      const inputBox = vscode.window.createInputBox();
      inputBox.title = 'Edit XHR Breakpoint';
      inputBox.placeholder = 'Enter a URL or a pattern to match';
      inputBox.value = (treeItem as XHRBreakpoint).match;
      inputBox.onDidAccept(() => {
        const match = inputBox.value;
        provider.removeBreakpoints([treeItem as XHRBreakpoint]);
        provider.addBreakpoints([new XHRBreakpoint({ match }, treeItem.checkboxState == 1)]);
        inputBox.dispose();
      });
      inputBox.show();
    }),
  );
}
