import * as vscode from 'vscode';
import Dap from '../dap/api';

export function toggleSkippingFile(aPath: string): void {
  if (!aPath) {
      const activeEditor = vscode.window.activeTextEditor;
      if (!activeEditor)
        return;
      aPath = activeEditor && activeEditor.document.fileName;
  }

  if (aPath && vscode.debug.activeDebugSession) {
      const args: Dap.ToggleSkipFileStatusParams = typeof aPath === 'string' ? { resource: aPath } : { sourceReference: aPath };
      vscode.debug.activeDebugSession.customRequest('toggleSkipFileStatus', args);
  }
}
