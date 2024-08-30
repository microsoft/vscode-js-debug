/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import { injectable } from 'inversify';
import * as vscode from 'vscode';
import { ExtensionContext } from 'vscode';
import { Configuration, isDebugType, readConfig, writeConfig } from '../common/contributionUtils';
import Dap from '../dap/api';
import { IExtensionContribution } from '../ioc-extras';

@injectable()
export class DisableSourceMapUI implements IExtensionContribution {
  public register(context: ExtensionContext) {
    context.subscriptions.push(
      vscode.debug.onDidReceiveDebugSessionCustomEvent(evt => {
        if (evt.event !== 'suggestDisableSourcemap' || !isDebugType(evt.session.type)) {
          return;
        }

        const body = evt.body as Dap.SuggestDisableSourcemapEventParams;
        this.unmap(evt.session, body.source).catch(err =>
          vscode.window.showErrorMessage(err.message)
        );
      }),
    );
  }

  private async unmap(session: vscode.DebugSession, source: Dap.Source) {
    const autoUnmap = readConfig(vscode.workspace, Configuration.UnmapMissingSources);
    if (autoUnmap || (await this.prompt())) {
      await session.customRequest('disableSourcemap', { source });
    }
  }

  private async prompt() {
    const always = l10n.t('Always');
    const alwayInWorkspace = l10n.t('Always in this Workspace');
    const yes = l10n.t('Yes');

    const result = await vscode.window.showInformationMessage(
      l10n.t(
        'This is a missing file path referenced by a sourcemap. Would you like to debug the compiled version instead?',
      ),
      always,
      alwayInWorkspace,
      l10n.t('No'),
      yes,
    );

    switch (result) {
      case always:
        writeConfig(
          vscode.workspace,
          Configuration.UnmapMissingSources,
          true,
          vscode.ConfigurationTarget.Global,
        );
        return true;
      case alwayInWorkspace:
        writeConfig(
          vscode.workspace,
          Configuration.UnmapMissingSources,
          true,
          vscode.ConfigurationTarget.Workspace,
        );
        return true;
      case yes:
        return true;
      default:
        return false;
    }
  }
}
