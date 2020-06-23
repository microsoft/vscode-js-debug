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
import { isMetaAddress } from '../common/urlUtils';
import urlRegex from 'url-regex';
import { IDisposable, DisposableList } from '../common/disposable';
import { once } from '../common/objUtils';

const localize = nls.loadMessageBundle();
const urlRe = urlRegex({ strict: true });

interface ITerminalLink extends vscode.TerminalLink {
  workspaceFolder?: number;
}

@injectable()
export class TerminalLinkHandler
  implements vscode.TerminalLinkProvider<ITerminalLink>, IDisposable {
  private readonly enabledTerminals = new WeakSet<vscode.Terminal>();
  private readonly disposable = new DisposableList();
  private notifiedCantOpenOnWeb = false;
  private baseConfiguration = this.readConfig();

  constructor(@inject(IDefaultBrowserProvider) private defaultBrowser: IDefaultBrowserProvider) {
    this.disposable.push(
      vscode.workspace.onDidChangeConfiguration(evt => {
        if (evt.affectsConfiguration(Configuration.DebugByLinkOptions)) {
          this.baseConfiguration = this.readConfig();
        }
      }),
    );
  }

  /**
   * Turns on link handling in the given terminal.
   */
  public enableHandlingInTerminal(terminal: vscode.Terminal) {
    this.enabledTerminals.add(terminal);
  }

  /**
   * @inheritdoc
   */
  public dispose() {
    this.disposable.dispose();
  }

  /**
   * @inheritdoc
   */
  public provideTerminalLinks(context: vscode.TerminalLinkContext) {
    switch (this.baseConfiguration.enabled) {
      case 'off':
        return [];
      case 'always':
        break;
      case 'on':
      default:
        if (!this.enabledTerminals.has(context.terminal)) {
          return [];
        }
    }

    const links: ITerminalLink[] = [];
    const getCwd = once(() => {
      // Do our best to resolve the right workspace folder to launch in, and debug
      if ('cwd' in context.terminal.creationOptions && context.terminal.creationOptions.cwd) {
        const folder = vscode.workspace.getWorkspaceFolder(
          typeof context.terminal.creationOptions.cwd === 'string'
            ? vscode.Uri.file(context.terminal.creationOptions.cwd)
            : context.terminal.creationOptions.cwd,
        );

        if (folder) {
          return folder;
        }
      }

      return vscode.workspace.workspaceFolders?.[0];
    });

    urlRe.lastIndex = 0;
    while (true) {
      const match = urlRe.exec(context.line);
      if (!match) {
        return links;
      }

      const uri = match[0].startsWith('http')
        ? vscode.Uri.parse(match[0])
        : vscode.Uri.parse(`https://${match[0]}`);

      if (uri.scheme !== 'http' && uri.scheme !== 'https') {
        continue;
      }

      links.push({
        startIndex: match.index,
        length: match[0].length,
        target: uri,
        workspaceFolder: getCwd()?.index,
      });
    }
  }

  /**
   * Launches a browser debug session when a link is clicked from a debug terminal.
   */
  public async handleTerminalLink(terminal: ITerminalLink): Promise<boolean> {
    if (!terminal.target) {
      return false;
    }

    let uri = terminal.target;

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

    if (isMetaAddress(uri.authority)) {
      uri = uri.with({ authority: 'localhost' });
    }

    let debugType: DebugType.Chrome | DebugType.Edge = DebugType.Chrome;
    try {
      if ((await this.defaultBrowser.lookup()) === DefaultBrowser.Edge) {
        debugType = DebugType.Edge;
      }
    } catch {
      // ignored
    }

    const cwd = terminal.workspaceFolder
      ? vscode.workspace.workspaceFolders?.[terminal.workspaceFolder]
      : undefined;

    vscode.debug.startDebugging(cwd, {
      ...this.baseConfiguration,
      type: debugType,
      name: uri.toString(),
      request: 'launch',
      url: uri.toString(),
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
