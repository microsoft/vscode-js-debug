/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import Dap from '../dap/api';
import * as nls from 'vscode-nls';
import { DebugSession, debug, workspace, window, QuickPickOptions, QuickPickItem } from 'vscode';
import { basename } from 'path';
import { logger } from '../common/logging/logger';
import { LogTag } from '../common/logging';

const localize = nls.loadMessageBundle();

interface ILoadedScriptItem extends QuickPickItem {
  source?: Dap.Source;
}

export const pickLoadedScript = async () => {
  const session = debug.activeDebugSession;

  const sources = await listLoadedScripts(session);
  let options: QuickPickOptions = {
    placeHolder: localize('select.script', 'Select a script'),
    matchOnDescription: true,
    matchOnDetail: true,
    ignoreFocusOut: true,
  };

  const items: ILoadedScriptItem[] = sources
    .map(source => ({
      source,
      description: source.path,
      label: basename(source.path!),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

  if (!items.length) {
    items.push({
      label: localize('no.loaded.scripts', 'No loaded scripts available'),
      description: '',
    });
  }

  const item = await window.showQuickPick(items, options);
  if (item && item.source) {
    openScript(session, item.source);
  }
};

export const openScript = async (session: DebugSession | undefined, source: Dap.Source) => {
  const uri = debug.asDebugSourceUri(source, session);
  const document = await workspace.openTextDocument(uri);
  await window.showTextDocument(document);
};

async function listLoadedScripts(session: DebugSession | undefined): Promise<Dap.Source[]> {
  if (!session) {
    return [];
  }

  try {
    return (await session.customRequest('loadedSources')).sources;
  } catch (e) {
    logger.warn(LogTag.Internal, 'Error requesting custom sources', e);
    return [];
  }
}
