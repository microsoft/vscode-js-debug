/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import * as vscode from 'vscode';
import { CancellationToken } from 'vscode';
import { IResourceProvider } from '../adapter/resourceProvider';

/**
 * Shape of a single target returned from the React Native dev server's
 * `/json/list` CDP endpoint. Only the fields we consume are typed; a real
 * response contains more.
 */
export interface IReactNativeTarget {
  title?: string;
  description?: string;
  appId?: string;
  webSocketDebuggerUrl?: string;
  deviceName?: string;
}

interface ITargetQuickPickItem extends vscode.QuickPickItem {
  target: IReactNativeTarget;
}

/**
 * Discovers debuggable React Native targets from the dev server (Metro)
 * inspector proxy listening on the given port and prompts the user to pick
 * one. A single dev server can expose multiple targets (e.g. several connected
 * devices or apps), so the picker surfaces each target's name and description.
 *
 * Returns the chosen target's inspector WebSocket URL, or `undefined` if the
 * user cancels. Throws if the dev server can't be reached or exposes no
 * debuggable targets.
 */
export async function pickReactNativeProcess(
  resourceProvider: IResourceProvider,
  port: number,
  cancellationToken?: CancellationToken,
): Promise<string | undefined> {
  const url = `http://localhost:${port}/json/list`;

  const response = await resourceProvider.fetchJson<IReactNativeTarget[]>(url, cancellationToken);
  if (!response.ok) {
    throw new Error(
      l10n.t(
        'Could not connect to the React Native dev server at {0}. Is Metro running? ({1})',
        `localhost:${port}`,
        response.error.message,
      ),
    );
  }

  const targets = response.body.filter(target => !!target.webSocketDebuggerUrl);
  if (targets.length === 0) {
    throw new Error(
      l10n.t(
        'No React Native debug targets were found on the dev server at {0}.',
        `localhost:${port}`,
      ),
    );
  }

  // With a single target there's no choice to make, so skip the picker.
  if (targets.length === 1) {
    return targets[0].webSocketDebuggerUrl;
  }

  const items = targets.map<ITargetQuickPickItem>(target => ({
    label: target.appId || target.title || l10n.t('React Native target'),
    description: target.deviceName,
    target,
  }));

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: l10n.t('Pick the React Native target to attach to'),
  });

  return picked?.target.webSocketDebuggerUrl;
}
