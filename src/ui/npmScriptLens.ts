/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { JSONVisitor, visit } from 'jsonc-parser';
import * as path from 'path';
import {
  CodeLens,
  CodeLensProvider,
  EventEmitter,
  ExtensionContext,
  languages,
  Position,
  Range,
  TextDocument,
  workspace,
} from 'vscode';
import * as nls from 'vscode-nls';
import { asCommand, Commands, Configuration, readConfig } from '../common/contributionUtils';
import { IDisposable } from '../common/disposable';
import { getPackageManager } from './getRunScriptCommand';

const localize = nls.loadMessageBundle();

const getFreshLensLocation = () => readConfig(workspace, Configuration.NpmScriptLens);

/**
 * Npm script lens provider implementation. Can show a "Debug" text above any
 * npm script, or the npm scripts section.
 */
export class NpmScriptLenProvider implements CodeLensProvider, IDisposable {
  private lensLocation = getFreshLensLocation();
  private changeEmitter = new EventEmitter<void>();
  private subscriptions: IDisposable[] = [];

  /**
   * @inheritdoc
   */
  public onDidChangeCodeLenses = this.changeEmitter.event;

  constructor() {
    this.subscriptions.push(
      workspace.onDidChangeConfiguration(evt => {
        if (evt.affectsConfiguration(Configuration.NpmScriptLens)) {
          this.lensLocation = getFreshLensLocation();
          this.changeEmitter.fire();
        }
      }),
    );
  }

  /**
   * @inheritdoc
   */
  public async provideCodeLenses(document: TextDocument): Promise<CodeLens[]> {
    if (this.lensLocation === 'never') {
      return [];
    }

    const tokens = this.tokenizeScripts(document);
    if (!tokens) {
      return [];
    }

    const title = localize('codelens.debug', '{0} Debug', '$(debug-start)');
    const cwd = path.dirname(document.uri.fsPath);
    if (this.lensLocation === 'top') {
      return [
        new CodeLens(
          new Range(tokens.scriptStart, tokens.scriptStart),
          asCommand({
            title,
            command: Commands.DebugNpmScript,
            arguments: [cwd],
          }),
        ),
      ];
    }

    if (this.lensLocation === 'all') {
      const workspaceFolder = workspace.getWorkspaceFolder(document.uri);
      const packageManager = await getPackageManager(workspaceFolder);
      return tokens.scripts.map(
        ({ name, position }) =>
          new CodeLens(
            new Range(position, position),
            asCommand({
              title,
              command: Commands.CreateDebuggerTerminal,
              arguments: [`${packageManager} run ${name}`, workspaceFolder, { cwd }],
            }),
          ),
      );
    }

    return [];
  }

  /**
   * @inheritdoc
   */
  public dispose() {
    this.subscriptions.forEach(s => s.dispose());
  }

  /**
   * Returns position data about the "scripts" section of the current JSON
   * document.
   */
  private tokenizeScripts(document: TextDocument) {
    let scriptStart: Position | undefined;
    let inScripts = false;
    let buildingScript: { name: string; position: Position } | void;
    let level = 0;
    const text = document.getText();
    const getPos = (offset: number) => {
      const line = text.slice(0, offset).match(/\n/g)?.length ?? 0;
      const character = offset - Math.max(0, text.lastIndexOf('\n', offset));
      return new Position(line, character);
    };

    const scripts: { name: string; value: string; position: Position }[] = [];

    const visitor: JSONVisitor = {
      onError() {
        // no-op
      },
      onObjectBegin() {
        level++;
      },
      onObjectEnd() {
        if (inScripts) {
          inScripts = false;
        }
        level--;
      },
      onLiteralValue(value: unknown) {
        if (buildingScript && typeof value === 'string') {
          scripts.push({ ...buildingScript, value });
          buildingScript = undefined;
        }
      },
      onObjectProperty(property: string, offset: number) {
        if (level === 1 && property === 'scripts') {
          inScripts = true;
          scriptStart = getPos(offset);
        } else if (inScripts) {
          buildingScript = { name: property, position: getPos(offset) };
        }
      },
    };

    visit(text, visitor);

    return scriptStart !== undefined ? { scriptStart, scripts } : undefined;
  }
}

export const registerNpmScriptLens = (context: ExtensionContext) => {
  const provider = new NpmScriptLenProvider();

  context.subscriptions.push(provider);
  context.subscriptions.push(
    languages.registerCodeLensProvider(
      {
        language: 'json',
        pattern: '**/package.json',
      },
      provider,
    ),
  );
};
