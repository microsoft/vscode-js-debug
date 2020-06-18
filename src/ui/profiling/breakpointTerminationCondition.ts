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
import { comparePathsWithoutCasingOrSlashes } from '../../common/urlUtils';

const localize = nls.loadMessageBundle();
const boolToInt = (v: boolean) => (v ? 1 : 0);
const warnedKey = 'breakpointTerminationWarnedSlow';

type BreakpointPickItem = {
  id: number;
  src?: { path: string; line: number; column: number };
} & vscode.QuickPickItem;

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
      quickPick.onDidChangeActive(async active => {
        for (const item of active) {
          if (!item.src) {
            continue;
          }

          const { path, line } = item.src;
          // todo: this would be a lot cleaner if vscode exposed DAP IDs
          const vscodeBp = vscode.debug.breakpoints.find(
            (bp): bp is vscode.SourceBreakpoint =>
              bp instanceof vscode.SourceBreakpoint &&
              bp.enabled &&
              // only compare lines, we don't really need column-precision for
              // this use case and doing so is hard because line breakpoints are
              // moved onto the column of the first statement by CDP.
              bp.location.range.start.line === line - 1 &&
              // note: although 'real' paths are slashed correctly, evaluated
              // scripts are given in the form <eval>/VM1234 which vscode will
              // turn into a backslash on windows.
              comparePathsWithoutCasingOrSlashes(bp.location.uri.fsPath, path),
          );
          if (!vscodeBp) {
            continue;
          }

          const document = await vscode.workspace.openTextDocument(vscodeBp.location.uri);
          vscode.window.showTextDocument(document, {
            selection: vscodeBp.location.range,
            preview: true,
            preserveFocus: true,
          });
        }
        const item = active.find(a => a.src);
        if (!item?.src) {
          return;
        }
      });

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
        'Profiling with breakpoints enabled can change the performance of your code. It can be useful to validate your findings with the "duration" or "manual" termination conditions.',
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
      lines?: Promise<string[] | undefined>;
      breakpoint: Dap.Breakpoint;
    }[] = [];

    const fileLines = new Map<string, Promise<string[] | undefined>>();

    for (const breakpoint of breakpoints) {
      if (!breakpoint.source || !breakpoint.id) {
        continue;
      }

      let relpath: string;
      let lines: Promise<string[] | undefined> | undefined;
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
        breakpoint,
        line: breakpoint.line ?? 1,
        column: breakpoint.column ?? 1,
      });
    }

    return Promise.all(
      filteredBps
        .sort(
          (a, b) =>
            boolToInt(b.breakpoint.verified) - boolToInt(a.breakpoint.verified) ||
            a.relpath.localeCompare(b.relpath) ||
            a.line - b.line ||
            a.column - b.column,
        )
        .map(async c => {
          const lines = await c.lines;
          return {
            id: c.breakpoint.id as number,
            src: c.breakpoint.source?.path
              ? { path: c.breakpoint.source?.path, line: c.line, column: c.column }
              : undefined,
            label: [forceForwardSlashes(c.relpath), c.line, c.column].join(':'),
            description: lines?.[c.line - 1].trim(),
          };
        }),
    );
  }

  private async getFileLines(path: string): Promise<string[] | undefined> {
    try {
      const contents = await this.fs.readFile(path, 'utf-8');
      return contents.split('\n');
    } catch {
      return undefined;
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
