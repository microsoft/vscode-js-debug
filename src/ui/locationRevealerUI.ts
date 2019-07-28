// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as vscode from 'vscode';
import { AdapterFactory } from '../adapterFactory';
import { Location, Source, LocationRevealer } from '../adapter/sources';
import { DebugAdapter } from '../adapter/debugAdapter';

export class LocationRevealerUI {
  _revealRequests = new Map<Source, () => void>();

  constructor(context: vscode.ExtensionContext, factory: AdapterFactory) {
    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(async editor => {
      if (this._revealRequests.size === 0 ||
        !editor ||
        editor.document.languageId !== 'javascript' ||
        editor.document.uri.scheme !== 'debug') {
        return;
      }

      const { source } = await factory.sourceForUri(factory, editor.document.uri);
      if (!source)
        return;
      const callback = this._revealRequests.get(source);
      if (callback) {
        this._revealRequests.delete(source);
        callback();
      }
    }));
    factory.adapters().forEach(adapter => this._install(adapter));
    factory.onAdapterAdded(adapter => this._install(adapter))
  }

  _install(adapter: DebugAdapter): void {
    adapter.sourceContainer.installRevealer(new Revealer(this, adapter));
  }
}

class Revealer implements LocationRevealer {
  private _revealerUI: LocationRevealerUI;
  private _adapter: DebugAdapter;

  constructor(revealerUI: LocationRevealerUI, adapter: DebugAdapter) {
    this._revealerUI = revealerUI;
    this._adapter = adapter;
  }

  async revealLocation(location: Location): Promise<undefined> {
    if (!location.source || this._revealerUI._revealRequests.has(location.source))
      return;
    const absolutePath = await location.source.existingAbsolutePath();
    if (absolutePath) {
      const document = await vscode.workspace.openTextDocument(absolutePath);
      if (!document)
        return;
      const editor = await vscode.window.showTextDocument(document);
      if (!editor)
        return;
      const position = new vscode.Position(location.lineNumber - 1, location.columnNumber - 1);
      editor.selection = new vscode.Selection(position, position);
      return;
    }

    const callback = new Promise<undefined>(f => this._revealerUI._revealRequests.set(location.source!, f));
    this._adapter.revealLocation(location, callback);
    await callback;
  }
}