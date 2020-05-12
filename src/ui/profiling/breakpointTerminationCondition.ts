/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { ITerminationConditionFactory, ITerminationCondition } from './terminationCondition';
import * as nls from 'vscode-nls';
import { injectable, inject } from 'inversify';
import * as vscode from 'vscode';
import * as path from 'path';
import Dap from '../../dap/api';
import { FS, FsPromises, ExtensionContext } from '../../ioc-extras';
import { forceForwardSlashes } from '../../common/pathUtils';

const localize = nls.loadMessageBundle();
const boolToInt = (v: boolean) => (v ? 1 : 0);
const warnedKey = 'breakpointTerminationWarnedSlow';

type BreakpointPickItem = { id: number } & vscode.QuickPickItem;

@injectable()
export class BreakpointTerminationConditionFactory implements ITerminationConditionFactory {
  public readonly sortOrder = 2;
  public readonly id = 'breakpoint';
  public readonly label = localize('profile.termination.breakpoint.label', 'Pick Breakpoint');
  public readonly description = localize(
    'profile.termination.breakpoint.description',
    'Run until a specific breakpoint is hit',
  );

  constructor(
    @inject(FS) private readonly fs: FsPromises,
    @inject(ExtensionContext) private readonly context: vscode.ExtensionContext,
  ) {}

  public async onPick(session: vscode.DebugSession, breakpointIds?: ReadonlyArray<number>) {
    if (breakpointIds) {
      return new BreakpointTerminationCondition(breakpointIds);
    }

    const quickPick = vscode.window.createQuickPick<BreakpointPickItem>();
    quickPick.canSelectMany = true;
    quickPick.busy = true;

    const chosen = await new Promise<ReadonlyArray<BreakpointPickItem> | undefined>(resolve => {
      quickPick.onDidAccept(() => resolve(quickPick.selectedItems));
      quickPick.onDidHide(() => resolve());
      quickPick.show();

      (async () => {
        const { breakpoints } = await session.customRequest('getBreakpoints');
        const candidates = await this.getCandidates(breakpoints);
        quickPick.items = candidates;
        quickPick.selectedItems = candidates;
        quickPick.busy = false;
      })();
    });

    quickPick.dispose();

    if (!chosen) {
      return;
    }

    await this.warnSlowCode();
    return new BreakpointTerminationCondition(chosen.map(c => Number(c.id)));
  }

  private async warnSlowCode() {
    if (this.context.workspaceState.get(warnedKey)) {
      return;
    }

    vscode.window.showWarningMessage(
      localize(
        'breakpointTerminationWarnSlow',
        'Profiling with breakpoints enabled can change the performance of your code. It can be ' +
          'useful to validate your findings with the "duration" or "manual" termination conditions.',
      ),
      localize('breakpointTerminationWarnConfirm', 'Got it!'),
    );
    await this.context.workspaceState.update(warnedKey, true);
  }

  private getCandidates(breakpoints: Dap.Breakpoint[]): Promise<BreakpointPickItem[]> {
    const filteredBps: {
      relpath: string;
      line: number;
      column: number;
      id: number;
      lines?: Promise<string[]>;
      verified: boolean;
    }[] = [];

    const fileLines = new Map<string, Promise<string[]>>();

    for (const breakpoint of breakpoints) {
      if (!breakpoint.source || !breakpoint.id) {
        continue;
      }

      let relpath: string;
      let lines: Promise<string[]> | undefined;
      if (!breakpoint.source.path) {
        relpath = `<unknown>${path.sep}${breakpoint.source.name}`;
      } else if (breakpoint.source.sourceReference === 0 && breakpoint.source.path) {
        const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(breakpoint.source.path));
        lines = fileLines.get(breakpoint.source.path) || this.getFileLines(breakpoint.source.path);
        fileLines.set(breakpoint.source.path, lines);
        relpath = folder
          ? path.relative(folder.uri.fsPath, breakpoint.source.path)
          : breakpoint.source.path;
      } else {
        relpath = breakpoint.source.name || breakpoint.source.path;
      }

      filteredBps.push({
        relpath,
        lines,
        verified: breakpoint.verified,
        id: breakpoint.id,
        line: breakpoint.line ?? 1,
        column: breakpoint.column ?? 1,
      });
    }

    return Promise.all(
      filteredBps
        .sort(
          (a, b) =>
            boolToInt(b.verified) - boolToInt(a.verified) ||
            a.relpath.localeCompare(b.relpath) ||
            a.line - b.line ||
            a.column - b.column,
        )
        .map(async c => ({
          id: c.id,
          label: [forceForwardSlashes(c.relpath), c.line, c.column].join(':'),
          description: (await c.lines)?.[c.line - 1].trim(),
        })),
    );
  }

  private async getFileLines(path: string): Promise<string[]> {
    try {
      const contents = await this.fs.readFile(path, 'utf-8');
      return contents.split('\n');
    } catch {
      return [];
    }
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
