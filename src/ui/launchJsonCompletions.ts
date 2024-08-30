/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import * as fs from 'fs/promises';
import { injectable } from 'inversify';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  Commands,
  DebugType,
  getPreferredOrDebugType,
  registerCommand,
} from '../common/contributionUtils';
import { existsInjected } from '../common/fsUtils';
import { truthy } from '../common/objUtils';
import { IExtensionContribution } from '../ioc-extras';
import { LaunchJsonUpdaterHelper } from './launchJsonUpdateHelper';

// jsonc-parser by default builds a UMD bundle that esbuild can't resolve.
// We alias it but that breaks the default types :( so require and explicitly type here
const { getLocation }: typeof import('jsonc-parser/lib/esm/main') = require('jsonc-parser');

// Based on Python's: https://github.com/microsoft/vscode-python-debugger/blob/30560bb94989a6510765d78bed3f636d6f0d0227/src/extension/debugger/configuration/launch.json/completionProvider.ts

@injectable()
export class LaunchJsonCompletions
  implements vscode.CompletionItemProvider, IExtensionContribution
{
  private hasNodeModules = new Map<vscode.WorkspaceFolder, boolean>();

  register(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      vscode.languages.registerCompletionItemProvider(
        { language: 'jsonc', pattern: '**/launch.json' },
        this,
      ),
      registerCommand(vscode.commands, Commands.CompletionNodeTool, async (document, position) => {
        await new NodeToolInserter().selectAndInsertDebugConfig(document, position);
      }),
    );
  }

  public async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.CompletionItem[]> {
    if (!(await this.canProvideCompletions(document, position))) {
      return [];
    }

    return [
      {
        command: {
          command: Commands.CompletionNodeTool,
          title: l10n.t('Run Node.js tool'),
          arguments: [document, position, token],
        },
        documentation: l10n.t(
          'Runs a Node.js command-line installed in the workspace node_modules.',
        ),
        sortText: 'AAAA',
        preselect: true,
        kind: vscode.CompletionItemKind.Enum,
        label: l10n.t('Run Node.js tool'),
        insertText: new vscode.SnippetString(),
      },
    ];
  }

  private async canProvideCompletions(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<boolean> {
    if (path.basename(document.uri.fsPath) !== 'launch.json') {
      return false;
    }

    const location = getLocation(document.getText(), document.offsetAt(position));
    // Cursor must be inside the configurations array and not in any nested items.
    // Hence path[0] = array, path[1] = array element index.
    if (!(location.path[0] === 'configurations' && location.path.length === 2)) {
      return false;
    }

    const wf = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!wf) {
      return false;
    }

    const hasNodeModules = this.hasNodeModules.get(wf)
      ?? !!(await existsInjected(fs, path.join(wf.uri.fsPath, 'node_modules', '.bin')));
    this.hasNodeModules.set(wf, hasNodeModules);
    return hasNodeModules;
  }
}

class NodeToolInserter extends LaunchJsonUpdaterHelper {
  protected async getLaunchConfig(
    folder: vscode.WorkspaceFolder | undefined,
  ): Promise<vscode.DebugConfiguration | undefined> {
    type TItem = vscode.QuickPickItem & { relativeDir: string };
    const pick = vscode.window.createQuickPick<TItem>();
    pick.title = l10n.t('Select a tool to run');
    pick.busy = true;
    pick.show();

    const options = await this.getOptions(folder);
    if (options.length === 0) {
      pick.dispose();
      vscode.window.showWarningMessage(l10n.t('No npm scripts found in the workspace folder.'));
      return;
    }

    let items: (vscode.QuickPickItem & { relativeDir: string })[] = [];
    for (const { names, relativeDir } of options) {
      if (relativeDir) {
        items.push({ label: relativeDir, kind: vscode.QuickPickItemKind.Separator, relativeDir });
      }
      items = items.concat(names.map(name => ({ label: name, relativeDir })));
    }
    pick.busy = false;
    pick.items = items;

    const chosen = await new Promise<TItem | undefined>(resolve => {
      pick.onDidAccept(() => resolve(pick.selectedItems[0]));
      pick.onDidHide(() => resolve(undefined));
    });
    pick.dispose();

    if (!chosen) {
      return;
    }

    return {
      type: getPreferredOrDebugType(DebugType.Node),
      request: 'launch',
      name: `Run ${chosen.label}`,
      runtimeExecutable: chosen.label,
      cwd: path.join('${workspaceFolder}', chosen.relativeDir).replaceAll('\\', '/'),
      args: [],
    };
  }

  private async getOptions(f: vscode.WorkspaceFolder | undefined) {
    if (!f) {
      return [];
    }

    const packageJsons = await vscode.workspace.findFiles(
      new vscode.RelativePattern(f, '**/package.json'),
    );
    const scripts = await Promise.all(packageJsons.map(async p => {
      try {
        const absoluteDir = path.dirname(p.fsPath);
        const bins = await fs.readdir(path.join(absoluteDir, 'node_modules', '.bin'));
        const names = new Set<string>();
        for (const bin of bins) {
          const ext = path.extname(bin);
          names.add(ext ? bin.slice(0, -ext.length) : bin);
        }

        return {
          relativeDir: path.relative(f.uri.fsPath, absoluteDir),
          names: Array.from(names),
        };
      } catch {
        return undefined;
      }
    }));

    return scripts.filter(truthy);
  }
}
