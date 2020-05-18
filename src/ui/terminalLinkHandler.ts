/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { injectable, inject } from 'inversify';
import * as vscode from 'vscode';
import * as nls from 'vscode-nls';
import { IDefaultBrowserProvider, DefaultBrowser } from '../common/defaultBrowserProvider';
import {
  readConfig,
  Configuration,
  DebugType,
  DebugByLinkState,
} from '../common/contributionUtils';
import { URL } from 'url';
import { isMetaAddress } from '../common/urlUtils';

const localize = nls.loadMessageBundle();

@injectable()
export class TerminalLinkHandler implements vscode.TerminalLinkHandler {
  private notifiedCantOpenOnWeb = false;
  private readonly enabledTerminals = new WeakSet<vscode.Terminal>();

  constructor(@inject(IDefaultBrowserProvider) private defaultBrowser: IDefaultBrowserProvider) {}

  /**
   * Turns on link handling in the given terminal.
   */
  public enableHandlingInTerminal(terminal: vscode.Terminal) {
    this.enabledTerminals.add(terminal);
  }

  /**
   * Launches a browser debug session when a link is clicked from a debug terminal.
   */
  public async handleLink(terminal: vscode.Terminal, link: string) {
    const baseConfig = this.readConfig();
    switch (baseConfig.enabled) {
      case 'off':
        return false;
      case 'always':
        break;
      case 'on':
      default:
        if (!this.enabledTerminals.has(terminal)) {
          return false;
        }
    }

    if (vscode.env.uiKind === vscode.UIKind.Web) {
      if (this.notifiedCantOpenOnWeb) {
        return false;
      }

      vscode.window.showInformationMessage(
        localize(
          'cantOpenChromeOnWeb',
          "We can't launch a browser in debug mode from here. If you want to debug this webpage, open this workspace from VS Code on your desktop.",
        ),
      );

      this.notifiedCantOpenOnWeb = true;
      return false;
    }

    // Don't debug things that explicitly aren't http/s
    let url: URL;
    try {
      url = new URL(link);
    } catch {
      return false; // invalid URL
    }

    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return false;
    }

    if (isMetaAddress(link)) {
      url.hostname = 'localhost';
      link = url.toString();
    }

    // Do our best to resolve the right workspace folder to launch in, and debug
    let cwd: vscode.WorkspaceFolder | undefined;
    if ('cwd' in terminal.creationOptions && terminal.creationOptions.cwd) {
      cwd = vscode.workspace.getWorkspaceFolder(
        typeof terminal.creationOptions.cwd === 'string'
          ? vscode.Uri.file(terminal.creationOptions.cwd)
          : terminal.creationOptions.cwd,
      );
    }

    if (!cwd) {
      cwd = vscode.workspace.workspaceFolders?.[0];
    }

    let debugType: DebugType.Chrome | DebugType.Edge = DebugType.Chrome;
    try {
      if ((await this.defaultBrowser.lookup()) === DefaultBrowser.Edge) {
        debugType = DebugType.Edge;
      }
    } catch {
      // ignored
    }

    vscode.debug.startDebugging(cwd, {
      ...baseConfig,
      type: debugType,
      name: link,
      request: 'launch',
      url: link,
    });

    return true;
  }

  private readConfig() {
    let baseConfig = readConfig(vscode.workspace, Configuration.DebugByLinkOptions);

    if (typeof baseConfig === 'boolean') {
      // old setting
      baseConfig = (baseConfig ? 'on' : 'off') as DebugByLinkState;
    }

    if (typeof baseConfig === 'string') {
      return { enabled: baseConfig };
    }

    return { enabled: 'on' as DebugByLinkState, ...baseConfig };
  }
}
