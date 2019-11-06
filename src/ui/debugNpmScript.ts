/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as fs from 'fs';
import * as vscode from 'vscode';
import * as path from 'path';
import * as nls from 'vscode-nls';
import { Contributions } from '../common/contributionUtils';

const localize = nls.loadMessageBundle();

interface IScript {
  directory: string;
  name: string;
  command: string;
}

type ScriptPickItem = vscode.QuickPickItem & { script: IScript };

/**
 * Opens a quickpick and them subsequently debugs a configured npm script.
 */
export async function debugNpmScript() {
  const scripts = await findScripts();
  if (!scripts) {
    return; // cancelled
  }

  // For multi-root workspaces, prefix the script name with the workspace
  // directory name so the user knows where it's coming from.
  const multiDir = scripts.some(s => s.directory !== scripts[0].directory);
  const quickPick = vscode.window.createQuickPick<ScriptPickItem>();
  quickPick.items = scripts.map(script => ({
    script,
    label: multiDir ? `${path.basename(script.directory)}: ${script.name}` : script.name,
    description: script.command,
  }));

  quickPick.onDidAccept(() => {
    const { script } = quickPick.selectedItems[0];
    vscode.debug.startDebugging(vscode.workspace.workspaceFolders![0], {
      type: Contributions.TerminalDebugType,
      name: quickPick.selectedItems[0].label,
      request: 'launch',
      cwd: script.directory,
      command: script.command,
    });

    quickPick.dispose();
  });

  quickPick.show();
}

/**
 * Finds configured npm scripts in the workspace.
 */
async function findScripts(): Promise<IScript[] | void> {
  const folders = vscode.workspace.workspaceFolders;

  // 1. If there are no open folders, show an error and abort.
  if (!folders || folders.length === 0) {
    vscode.window.showErrorMessage(
      localize(
        'debug.npm.noWorkspaceFolder',
        'You need to open a workspace folder to debug npm scripts.',
      ),
    );
    return;
  }

  // Otherwise, go through all package.json's in the folder and pull all the npm scripts we find.
  const candidates = folders.map(f => path.join(f.uri.fsPath, 'package.json'));
  const scripts: IScript[] = [];

  // editCandidate is the file we'll edit if we don't find any npm scripts.
  // We 'narrow' this as we parse to files that look more like a package.json we want
  let editCandidate = candidates[0];
  for (const packageJson of candidates) {
    if (!fs.existsSync(packageJson)) {
      continue;
    }

    editCandidate = packageJson; // update this now, because we know it exists

    let parsed: { scripts?: { [key: string]: string } };
    try {
      parsed = JSON.parse(fs.readFileSync(packageJson, 'utf-8'));
    } catch (e) {
      promptToOpen(
        'showWarningMessage',
        localize('debug.npm.parseError', 'Could not read {0}: {1}', packageJson, e.message),
        packageJson,
      );
      continue;
    }

    editCandidate = packageJson; // update this now, because we know it is valid

    if (!parsed.scripts) {
      continue;
    }

    for (const key of Object.keys(parsed.scripts)) {
      scripts.push({
        directory: path.dirname(packageJson),
        name: key,
        command: parsed.scripts[key],
      });
    }
  }

  if (scripts.length === 0) {
    promptToOpen(
      'showErrorMessage',
      localize('debug.npm.noScripts', 'No npm scripts found in your package.json'),
      editCandidate,
    );
    return;
  }

  return scripts;
}

const defaultPackageJsonContents = `{\n  "scripts": {\n    \n  }\n}\n`;

async function promptToOpen(
  method: 'showWarningMessage' | 'showErrorMessage',
  message: string,
  file: string,
) {
  const openAction = localize('debug.npm.notFound.open', 'Edit package.json');
  if ((await vscode.window[method](message, openAction)) !== openAction) {
    return;
  }

  // If the file exists, open it, otherwise create a new untitled file and
  // fill it in with some minimal "scripts" section.
  if (fs.existsSync(file)) {
    const document = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(document);
    return;
  }

  const document = await vscode.workspace.openTextDocument(
    vscode.Uri.file(file).with({ scheme: 'untitled' }),
  );
  const editor = await vscode.window.showTextDocument(document);
  await editor.edit(e => e.insert(new vscode.Position(0, 0), defaultPackageJsonContents));
  const pos = new vscode.Position(2, 5);
  editor.selection = new vscode.Selection(pos, pos);
}
