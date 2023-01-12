/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import { inject, injectable } from 'inversify';
import { URL } from 'url';
import * as vscode from 'vscode';
import {
  Commands,
  Configuration,
  DebugType,
  getPreferredOrDebugType,
  readConfig,
} from '../common/contributionUtils';
import { DefaultBrowser, IDefaultBrowserProvider } from '../common/defaultBrowserProvider';
import { ExtensionContext, IExtensionContribution } from '../ioc-extras';

function getPossibleUrl(link: string, requirePort: boolean): string | undefined {
  if (!link) {
    return;
  }

  // if the link is already valid, all good
  try {
    if (new URL(link).hostname) {
      return link;
    }
  } catch {
    // not a valid link
  }

  // if it's in the format `<hostname>:<port>` then assume it's a url
  try {
    const prefixed = `http://${link}`;
    const url = new URL(prefixed);
    if (!requirePort || url.port) {
      return prefixed;
    }
  } catch {
    // not a valid link
  }
}

@injectable()
export class DebugLinkUi implements IExtensionContribution {
  private mostRecentLink: string | undefined;

  constructor(
    @inject(IDefaultBrowserProvider) private defaultBrowser: IDefaultBrowserProvider,
    @inject(ExtensionContext) private context: vscode.ExtensionContext,
  ) {}

  /**
   * Registers the link UI for the extension.
   */
  public register(context: vscode.ExtensionContext) {
    context.subscriptions.push(
      vscode.commands.registerCommand(Commands.DebugLink, link => this.handle(link)),
    );
  }

  /**
   * Handles a command, optionally called with a link.
   */
  public async handle(link?: string) {
    link = link ?? (await this.getLinkFromTextEditor()) ?? (await this.getLinkFromQuickInput());
    if (!link) {
      return;
    }

    let debugType: DebugType.Chrome | DebugType.Edge = DebugType.Chrome;
    try {
      if ((await this.defaultBrowser.lookup()) === DefaultBrowser.Edge) {
        debugType = DebugType.Edge;
      }
    } catch {
      // ignored
    }

    const baseConfig = readConfig(vscode.workspace, Configuration.DebugByLinkOptions) ?? {};
    const config = {
      ...(typeof baseConfig === 'string' ? {} : baseConfig),
      type: getPreferredOrDebugType(debugType),
      name: link,
      request: 'launch',
      url: link,
    };

    vscode.debug.startDebugging(vscode.workspace.workspaceFolders?.[0], config);
    this.persistConfig(config);
  }

  private getLinkFromTextEditor() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }

    return getPossibleUrl(editor.document.getText(editor.selection), true);
  }

  private async getLinkFromQuickInput() {
    const clipboard = await vscode.env.clipboard.readText();
    const link = await vscode.window.showInputBox({
      value: getPossibleUrl(clipboard, false) || this.mostRecentLink,
      placeHolder: 'https://localhost:8080',
      validateInput: input => {
        if (input && !getPossibleUrl(input, false)) {
          return l10n.t('The URL provided is invalid');
        }
      },
    });

    if (!link) {
      return;
    }

    this.mostRecentLink = link;
    return link;
  }

  private async persistConfig(config: { url: string }) {
    if (this.context.globalState.get('saveDebugLinks') === false) {
      return;
    }

    const launchJson = vscode.workspace.getConfiguration('launch');
    const configs = (launchJson.get('configurations') ?? []) as { url?: string }[];
    if (configs.some(c => c.url === config.url)) {
      return;
    }

    const yes = l10n.t('Yes');
    const never = l10n.t('Never');
    const r = await vscode.window.showInformationMessage(
      l10n.t('Would you like to save a configuration in your launch.json for easy access later?'),
      yes,
      l10n.t('No'),
      never,
    );

    if (r === never) {
      this.context.globalState.update('saveDebugLinks', false);
    }

    if (r !== yes) {
      return;
    }

    await launchJson.update('configurations', [...configs, config]);
  }
}
