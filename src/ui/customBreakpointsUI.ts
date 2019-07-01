import * as vscode from 'vscode';
import {CustomBreakpoint, customBreakpoints} from '../adapter/customBreakpoints';
import Dap from '../dap/api';

class Breakpoint {
  customBreakpoint: CustomBreakpoint;
  enabled: boolean;
  group: Group;

  constructor(cb: CustomBreakpoint, enabled: boolean, group: Group) {
    this.customBreakpoint = cb;
    this.enabled = enabled;
    this.group = group;
  }

  static compare(a: Breakpoint, b: Breakpoint) {
    return a.customBreakpoint.title < b.customBreakpoint.title ? -1 : 1;
  }
}

type GroupEnabledState = 'yes' | 'no' | 'partial';

class Group {
  title: string;
  breakpoints: Breakpoint[] = [];

  constructor(title: string) {
    this.title = title;
  }

  enabled(): GroupEnabledState {
    const count = this.breakpoints.map(b => b.enabled ? 1 : 0).reduce((a, b) => a + b, 0);
    return count === this.breakpoints.length ? 'yes' : (count === 0 ? 'no' : 'partial');
  }

  static compare(a: Group, b: Group) {
    return a.title < b.title ? -1 : 1;
  }
}

type DataItem = Breakpoint | Group;

class BreakpointItem extends vscode.TreeItem {
  breakpoint: Breakpoint;

  constructor(breakpoint: Breakpoint) {
    super(
      (breakpoint.enabled ? '▣' : '▢') + '\u00a0\u00a0' + breakpoint.customBreakpoint.title,
      vscode.TreeItemCollapsibleState.None);
    this.breakpoint = breakpoint;
    this.id = breakpoint.customBreakpoint.id;
    this.contextValue = breakpoint.enabled ? 'cdpCustomBreakpointEnabled' : 'cdpCustomBreakpointDisabled';
  }
}

class GroupItem extends vscode.TreeItem {
  group: Group;

  constructor(group: Group) {
    const enabled = group.enabled();
    // ️️☑️⬜▦
    super(
      (enabled === 'yes' ? '▣' : (enabled === 'no' ? '▢' : '▦')) + '\u00a0\u00a0' + group.title,
      vscode.TreeItemCollapsibleState.Collapsed);
    this.group = group;
    this.id = group.title;
    this.contextValue = enabled !== 'no' ? 'cdpCustomBreakpointGroupEnabled' : 'cdpCustomBreakpointGroupDisabled';
  }
}

class BreakpointsDataProvider implements vscode.TreeDataProvider<DataItem> {
	private _onDidChangeTreeData: vscode.EventEmitter<DataItem | undefined> = new vscode.EventEmitter<DataItem | undefined>();
  readonly onDidChangeTreeData: vscode.Event<DataItem | undefined> = this._onDidChangeTreeData.event;

  groups = new Map<string, Group>();
  memento: vscode.Memento;

  constructor(memento: vscode.Memento) {
    this.memento = memento;

    const enabled = new Set(memento.get<string[]>('cdp.customBreakpoints', []));
    for (const cb of customBreakpoints.values()) {
      let group = this.groups.get(cb.group);
      if (!group) {
        group = new Group(cb.group);
        this.groups.set(group.title, group);
      }
      group.breakpoints.push(new Breakpoint(cb, enabled.has(cb.id), group));
    }

    const sendState = (session: vscode.DebugSession) => {
      if (session.type !== 'cdp')
        return;
      session.customRequest('updateCustomBreakpoints', {breakpoints: this._collectState().map(id => {
        return {id, enabled: true};
      })});
    };
    vscode.debug.onDidStartDebugSession(sendState);
    if (vscode.debug.activeDebugSession)
      sendState(vscode.debug.activeDebugSession);
  }

	getTreeItem(item: DataItem): vscode.TreeItem {
    return item instanceof Breakpoint ? new BreakpointItem(item) : new GroupItem(item);
	}

	getChildren(item?: DataItem): Thenable<DataItem[]> {
		if (!item)
      return Promise.resolve(Array.from(this.groups.values()).sort(Group.compare));
    return Promise.resolve(item instanceof Group ? item.breakpoints.sort(Breakpoint.compare) : []);
  }

  getParent(item: DataItem): Thenable<DataItem | undefined> {
    return Promise.resolve(item instanceof Group ? undefined : item.group);
  }

  update(breakpoints: Breakpoint[], enabled: boolean) {
    const payload: Dap.CustomBreakpoint[] = [];
    for (const b of breakpoints) {
      if (b.enabled !== enabled) {
        b.enabled = enabled;
        payload.push({id: b.customBreakpoint.id, enabled});
      }
    }
    this.memento.update('cdp.customBreakpoints', this._collectState());
    const session = vscode.debug.activeDebugSession;
    if (session && session.type === 'cdp')
      session.customRequest('updateCustomBreakpoints', {breakpoints: payload});
    this._onDidChangeTreeData.fire(undefined);
  }

  _collectState(): string[] {
    const state: string[] = [];
    for (const group of this.groups.values()) {
      for (const breakpoint of group.breakpoints) {
        if (breakpoint.enabled)
          state.push(breakpoint.customBreakpoint.id);
      }
    }
    return state;
  }
}

export function registerCustomBreakpointsUI(context: vscode.ExtensionContext) {
  const memento = context.workspaceState;
  const provider = new BreakpointsDataProvider(memento);

  // TODO(dgozman): figure out UI logic, it is somewhat annoying.
  const treeView = vscode.window.createTreeView('cdpBreakpoints', { treeDataProvider: provider });
  function showTreeView() {
    treeView.reveal(provider.groups[0], {select: false});
  }

  vscode.debug.onDidStartDebugSession((session: vscode.DebugSession) => {
    const lastType = memento.get<string>('cdpLastDebugSessionType');
    memento.update('cdpLastDebugSessionType', session.type);
    if (session.type === 'cdp' && lastType !== 'cdp')
      showTreeView();
  });
  if (memento.get<string>('cdpLastDebugSessionType') === 'cdp')
    showTreeView();

  context.subscriptions.push(vscode.commands.registerCommand('cdp.enableCustomBreakpoint', (breakpoint: Breakpoint) => {
    provider.update([breakpoint], true);
  }));
  context.subscriptions.push(vscode.commands.registerCommand('cdp.disableCustomBreakpoint', (breakpoint: Breakpoint) => {
    provider.update([breakpoint], false);
  }));
  context.subscriptions.push(vscode.commands.registerCommand('cdp.enableCustomBreakpointGroup', (group: Group) => {
    provider.update(group.breakpoints, true);
  }));
  context.subscriptions.push(vscode.commands.registerCommand('cdp.disableCustomBreakpointGroup', (group: Group) => {
    provider.update(group.breakpoints, false);
  }));
}
