/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as vscode from 'vscode';

// jsonc-parser by default builds a UMD bundle that esbuild can't resolve.
// We alias it but that breaks the default types :( so require and explicitly type here
const { createScanner, parse, SyntaxKind }: typeof import('jsonc-parser/lib/esm/main') = require(
  'jsonc-parser',
);

type PositionOfCursor = 'InsideEmptyArray' | 'BeforeItem' | 'AfterItem';
type PositionOfComma = 'BeforeCursor';

// Based on Python's service here: https://github.com/microsoft/vscode-python-debugger/blob/main/src/extension/debugger/configuration/launch.json/updaterServiceHelper.ts

export abstract class LaunchJsonUpdaterHelper {
  public async selectAndInsertDebugConfig(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<void> {
    const activeTextEditor = vscode.window.activeTextEditor;
    if (activeTextEditor && activeTextEditor.document === document) {
      const folder = vscode.workspace.getWorkspaceFolder(document.uri);
      const config = await this.getLaunchConfig(folder);
      if (config) {
        await LaunchJsonUpdaterHelper.insertDebugConfiguration(document, position, config);
      }
    }
  }

  protected abstract getLaunchConfig(
    folder: vscode.WorkspaceFolder | undefined,
  ): Promise<vscode.DebugConfiguration | undefined>;

  /**
   * Inserts the debug configuration into the document.
   * Invokes the document formatter to ensure JSON is formatted nicely.
   * @param {TextDocument} document
   * @param {Position} position
   * @param {DebugConfiguration} config
   * @returns {Promise<void>}
   * @memberof LaunchJsonCompletionItemProvider
   */
  public static async insertDebugConfiguration(
    document: vscode.TextDocument,
    position: vscode.Position,
    config: vscode.DebugConfiguration,
  ): Promise<void> {
    const cursorPosition = LaunchJsonUpdaterHelper.getCursorPositionInConfigurationsArray(
      document,
      position,
    );
    if (!cursorPosition) {
      return;
    }
    const commaPosition = LaunchJsonUpdaterHelper.isCommaImmediatelyBeforeCursor(document, position)
      ? 'BeforeCursor'
      : undefined;
    const formattedJson = LaunchJsonUpdaterHelper.getTextForInsertion(
      config,
      cursorPosition,
      commaPosition,
    );
    const workspaceEdit = new vscode.WorkspaceEdit();
    workspaceEdit.insert(document.uri, position, formattedJson);
    await vscode.workspace.applyEdit(workspaceEdit);
    Promise.resolve(vscode.commands.executeCommand('editor.action.formatDocument')).then(() => {
      // noop
    });
  }

  /**
   * Gets the string representation of the debug config for insertion in the document.
   * Adds necessary leading or trailing commas (remember the text is added into an array).
   * @param {DebugConfiguration} config
   * @param {PositionOfCursor} cursorPosition
   * @param {PositionOfComma} [commaPosition]
   * @returns
   * @memberof LaunchJsonCompletionItemProvider
   */
  public static getTextForInsertion(
    config: vscode.DebugConfiguration,
    cursorPosition: PositionOfCursor,
    commaPosition?: PositionOfComma,
  ): string {
    const json = JSON.stringify(config);
    if (cursorPosition === 'AfterItem') {
      // If we already have a comma immediately before the cursor, then no need of adding a comma.
      return commaPosition === 'BeforeCursor' ? json : `,${json}`;
    }
    if (cursorPosition === 'BeforeItem') {
      return `${json},`;
    }
    return json;
  }

  public static getCursorPositionInConfigurationsArray(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): PositionOfCursor | undefined {
    if (LaunchJsonUpdaterHelper.isConfigurationArrayEmpty(document)) {
      return 'InsideEmptyArray';
    }
    const scanner = createScanner(document.getText(), true);
    scanner.setPosition(document.offsetAt(position));
    const nextToken = scanner.scan();
    if (nextToken === SyntaxKind.CommaToken || nextToken === SyntaxKind.CloseBracketToken) {
      return 'AfterItem';
    }
    if (nextToken === SyntaxKind.OpenBraceToken) {
      return 'BeforeItem';
    }
    return undefined;
  }

  public static isConfigurationArrayEmpty(document: vscode.TextDocument): boolean {
    const configuration = parse(document.getText(), [], {
      allowTrailingComma: true,
      disallowComments: false,
    }) as {
      configurations: [];
    };
    return (
      !configuration || !Array.isArray(configuration.configurations)
      || configuration.configurations.length === 0
    );
  }

  public static isCommaImmediatelyBeforeCursor(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): boolean {
    const line = document.lineAt(position.line);
    // Get text from start of line until the cursor.
    const currentLine = document.getText(new vscode.Range(line.range.start, position));
    if (currentLine.trim().endsWith(',')) {
      return true;
    }
    // If there are other characters, then don't bother.
    if (currentLine.trim().length !== 0) {
      return false;
    }

    // Keep walking backwards until we hit a non-comma character or a comm character.
    let startLineNumber = position.line - 1;
    while (startLineNumber > 0) {
      const lineText = document.lineAt(startLineNumber).text;
      if (lineText.trim().endsWith(',')) {
        return true;
      }
      // If there are other characters, then don't bother.
      if (lineText.trim().length !== 0) {
        return false;
      }
      startLineNumber -= 1;
    }
    return false;
  }
}
