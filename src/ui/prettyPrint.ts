/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as vscode from 'vscode';
import * as qs from 'querystring';
import {
  readConfig,
  Configuration,
  writeConfig,
  registerCommand,
  Commands,
  allDebugTypes,
} from '../common/contributionUtils';
import Dap from '../dap/api';
import { Message as DapMessage } from '../dap/transport';
import { IDisposable, DisposableList } from '../common/disposable';
import * as nls from 'vscode-nls';
import { DebugSessionTracker } from './debugSessionTracker';

const localize = nls.loadMessageBundle();

export class PrettyPrintTrackerFactory implements vscode.DebugAdapterTrackerFactory, IDisposable {
  private readonly sessions = new DisposableList();

  /**
   * Attaches the tracker to the VS Code workspace.
   */
  public static register(tracker: DebugSessionTracker): PrettyPrintTrackerFactory {
    const factory = new PrettyPrintTrackerFactory(tracker);
    for (const debugType of allDebugTypes) {
      vscode.debug.registerDebugAdapterTrackerFactory(debugType, factory);
    }

    registerCommand(vscode.commands, Commands.PrettyPrint, () => factory.prettifyActive());

    return factory;
  }

  constructor(private readonly tracker: DebugSessionTracker) {}

  /**
   * @inheritdoc
   */
  public createDebugAdapterTracker(
    session: vscode.DebugSession,
  ): vscode.ProviderResult<vscode.DebugAdapterTracker> {
    if (!readConfig(vscode.workspace, Configuration.SuggestPrettyPrinting)) {
      return;
    }

    const tracker = new PrettyPrintSession(session);
    this.sessions.push(tracker);
    vscode.debug.onDidTerminateDebugSession(s => {
      if (s === session) {
        this.sessions.disposeObject(tracker);
      }
    });

    return tracker;
  }

  /**
   * Prettifies the active file in the editor.
   */
  public async prettifyActive() {
    const editor = vscode.window.activeTextEditor;
    if (editor?.document.languageId !== 'javascript') {
      return;
    }

    const { sessionId, source } = sourceForUri(editor.document.uri);
    const session = sessionId && this.tracker.sessions.get(sessionId);

    // For ephemeral files, they're attached to a single session, so go ahead
    // and send it to the owning session. For files on disk, send it to all
    // sessions--they will no-op if they don't know about the source.
    if (session) {
      sendPrintCommand(session, source, editor.selection.start);
    } else {
      for (const session of this.tracker.sessions.values()) {
        sendPrintCommand(session, source, editor.selection.start);
      }
    }
  }

  /**
   * @inheritdoc
   */
  public dispose() {
    this.sessions.dispose();
  }
}

/**
 * Session tracker for pretty printing. It monitors open files in the editor,
 * and suggests formatting ones that look minified.
 *
 * It can suggest printing ephemeral files that have a source reference set.
 * It will also suggest printing
 */
class PrettyPrintSession implements IDisposable, vscode.DebugAdapterTracker {
  private readonly candidatePaths = new Set<string>();
  private readonly disposable = new DisposableList();
  private readonly suggested = new Set<string | number>();

  constructor(private readonly session: vscode.DebugSession) {
    this.disposable.push(
      vscode.window.onDidChangeActiveTextEditor(editor => this.onEditorChange(editor)),
    );
  }

  /**
   * @inheritdoc
   */
  public onDidSendMessage(message: DapMessage) {
    if (message.type !== 'response' || message.command !== 'stackTrace' || !message.body) {
      return;
    }

    const frames = (message.body as Dap.StackTraceResult).stackFrames;
    if (!frames) {
      return;
    }

    for (const frame of frames) {
      const path = frame.source?.path;
      if (path) {
        this.candidatePaths.add(path);
      }
    }

    // If the file that's currently opened is the top of the stacktrace,
    // indicating we're probably about to break on it, then prompt immediately.
    const first = frames[0]?.source?.path;
    if (first && vscode.window.activeTextEditor?.document.uri.path === first) {
      this.onEditorChange(vscode.window.activeTextEditor);
    }
  }

  /**
   * @inheritdoc
   */
  public dispose() {
    this.disposable.dispose();
  }

  private onEditorChange(editor: vscode.TextEditor | undefined) {
    if (editor?.document.languageId !== 'javascript') {
      return;
    }

    const { source } = sourceForUri(editor.document.uri);
    if (!this.candidatePaths.has(source.path) && source.sourceReference === 0) {
      return;
    }

    const key = source.sourceReference || source.path;
    if (this.suggested.has(key)) {
      return;
    }

    this.suggested.add(key);
    if (!isMinified(editor.document)) {
      return;
    }

    return this.trySuggestPrinting(source, editor.selection.start);
  }

  private async trySuggestPrinting(source: Dap.Source, cursor: vscode.Position) {
    const canPrettyPrint = await this.session.customRequest('canPrettyPrintSource', {
      source,
    });

    if (!canPrettyPrint?.canPrettyPrint) {
      return;
    }

    const yes = localize('yes', 'Yes');
    const no = localize('no', 'No');
    const never = localize('never', 'Never');
    const response = await vscode.window.showInformationMessage(
      'This JavaScript file seems to be minified.\nWould you like to pretty print it?',
      yes,
      no,
      never,
    );

    if (response === yes) {
      sendPrintCommand(this.session, source, cursor);
    } else if (response === never) {
      writeConfig(vscode.workspace, Configuration.SuggestPrettyPrinting, false);
    }
  }
}

const sendPrintCommand = (
  session: vscode.DebugSession,
  source: Dap.Source,
  cursor: vscode.Position,
) =>
  session.customRequest('prettyPrintSource', {
    source,
    line: cursor.line,
    column: cursor.character,
  });

/**
 * Gets the DAP source and session for a VS Code document URI.
 */
const sourceForUri = (uri: vscode.Uri) => {
  const query = qs.parse(uri.query);
  const sessionId: string | undefined = query['session'] as string;
  const source = {
    path: uri.fsPath,
    sourceReference: Number(query['ref']) || 0,
  };

  return { sessionId, source };
};

/**
 * Heuristic check to see if a document is minified.
 */
function isMinified(document: vscode.TextDocument): boolean {
  const maxNonMinifiedLength = 500;
  const linesToCheck = 10;
  for (let i = 0; i < linesToCheck && i < document.lineCount; ++i) {
    const line = document.lineAt(i).text;
    if (line.length > maxNonMinifiedLength && !line.startsWith('//#')) {
      return true;
    }
  }

  return false;
}
