/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { inject, injectable } from 'inversify';
import * as path from 'path';
import * as vscode from 'vscode';
import * as nls from 'vscode-nls';
import { memoize, truthy } from '../../common/objUtils';
import Dap from '../../dap/api';
import { ExtensionContext, FS, FsPromises } from '../../ioc-extras';
import { ITerminationCondition, ITerminationConditionFactory } from './terminationCondition';

const localize = nls.loadMessageBundle();
const warnedKey = 'breakpointTerminationWarnedSlow';

type BreakpointPickItem = {
  id: number;
  location: vscode.Location;
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
    quickPick.matchOnDescription = true;
    quickPick.busy = true;

    const chosen = await new Promise<ReadonlyArray<BreakpointPickItem> | undefined>(resolve => {
      quickPick.onDidAccept(() => resolve(quickPick.selectedItems));
      quickPick.onDidHide(() => resolve());
      quickPick.onDidChangeActive(async active => {
        if (!active.length) {
          return;
        }

        const location = active[0].location;
        const document = await vscode.workspace.openTextDocument(location.uri);
        vscode.window.showTextDocument(document, {
          selection: location.range,
          preview: true,
          preserveFocus: true,
        });
      });

      quickPick.show();

      (async () => {
        const codeBps = vscode.debug.breakpoints.filter(
          bp => bp.enabled && bp instanceof vscode.SourceBreakpoint,
        );
        const dapBps = await Promise.all(codeBps.map(bp => session.getDebugProtocolBreakpoint(bp)));
        const candidates = await this.getCandidates(
          dapBps as (Dap.Breakpoint | undefined)[],
          codeBps as vscode.SourceBreakpoint[],
        );

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

  private async getCandidates(
    dapBps: ReadonlyArray<Dap.Breakpoint | undefined>,
    codeBps: ReadonlyArray<vscode.SourceBreakpoint>,
  ): Promise<BreakpointPickItem[]> {
    if (dapBps.length !== codeBps.length) {
      throw new Error('Mismatched breakpoint array lengths');
    }

    const getLines = memoize((f: string) => this.getFileLines(f));

    const candidates = await Promise.all(
      codeBps.map(
        async (codeBp, i): Promise<BreakpointPickItem | undefined> => {
          const dapBp = dapBps[i];
          if (!dapBp || !dapBp.id) {
            return; // does not apply to this session
          }

          const location = codeBp.location;
          const folder = vscode.workspace.getWorkspaceFolder(location.uri);
          const labelPath = folder
            ? path.relative(folder.uri.fsPath, location.uri.fsPath)
            : location.uri.fsPath;
          const lines = await getLines(location.uri.fsPath);

          return {
            id: dapBp.id,
            label: `${labelPath}:${location.range.start.line}:${location.range.start.character}`,
            location,
            description: lines?.[location.range.start.line]?.trim(),
          };
        },
      ),
    );

    return candidates.filter(truthy);
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
