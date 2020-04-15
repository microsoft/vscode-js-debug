/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { ITerminationConditionFactory, ITerminationCondition } from './terminationCondition';
import * as nls from 'vscode-nls';
import { injectable } from 'inversify';
import * as vscode from 'vscode';
import * as path from 'path';
import Dap from '../../dap/api';

const localize = nls.loadMessageBundle();

const boolToInt = (v: boolean) => (v ? 1 : 0);

type BreakpointPickItem = { id: number } & vscode.QuickPickItem;

@injectable()
export class BreakpointTerminationConditionFactory implements ITerminationConditionFactory {
  public readonly sortOrder = 2;
  public readonly label = localize('profile.termination.breakpoint.label', 'Pick Breakpoint');
  public readonly description = localize(
    'profile.termination.breakpoint.description',
    'Run until a specific breakpoint is hit',
  );

  public async onPick(session: vscode.DebugSession) {
    const quickPick = vscode.window.createQuickPick<BreakpointPickItem>();
    quickPick.canSelectMany = true;
    quickPick.busy = true;

    const chosen = await new Promise<ReadonlyArray<BreakpointPickItem> | undefined>(resolve => {
      quickPick.onDidAccept(() => resolve(quickPick.selectedItems));
      quickPick.onDidHide(() => resolve());
      quickPick.show();

      session.customRequest('getBreakpoints').then(({ breakpoints }) => {
        quickPick.items = quickPick.selectedItems = this.getCandidates(breakpoints);
        quickPick.busy = false;
      });
    });

    quickPick.dispose();

    if (!chosen) {
      return;
    }

    return new BreakpointTerminationCondition(chosen.map(c => Number(c.id)));
  }

  private getCandidates(breakpoints: Dap.Breakpoint[]): BreakpointPickItem[] {
    const filteredBps: {
      relpath: string;
      line: number;
      column: number;
      id: number;
      verified: boolean;
    }[] = [];

    for (const breakpoint of breakpoints) {
      if (!breakpoint.source || !breakpoint.id) {
        continue;
      }

      let relpath: string;
      if (!breakpoint.source.path) {
        relpath = `<unknown>${path.sep}${breakpoint.source.name}`;
      } else if (breakpoint.source.sourceReference === 0 && breakpoint.source.path) {
        const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(breakpoint.source.path));
        relpath = folder
          ? path.relative(folder.uri.fsPath, breakpoint.source.path)
          : breakpoint.source.path;
      } else {
        relpath = breakpoint.source.name || breakpoint.source.path;
      }

      filteredBps.push({
        relpath,
        verified: breakpoint.verified,
        id: breakpoint.id,
        line: breakpoint.line ?? 1,
        column: breakpoint.column ?? 1,
      });
    }

    return filteredBps
      .sort(
        (a, b) =>
          boolToInt(b.verified) - boolToInt(a.verified) ||
          a.relpath.localeCompare(b.relpath) ||
          a.line - b.line ||
          a.column - b.column,
      )
      .map(c => ({
        id: c.id,
        label: [path.basename(c.relpath), c.line, c.column].join(':'),
        description: c.relpath,
      }));
  }
}

class BreakpointTerminationCondition implements ITerminationCondition {
  public get customData() {
    return {
      stopAtBreakpoint: this.breakpointIds.slice(),
    };
  }

  constructor(private readonly breakpointIds: ReadonlyArray<number>) {}

  public dispose() {
    // no-op
  }
}
