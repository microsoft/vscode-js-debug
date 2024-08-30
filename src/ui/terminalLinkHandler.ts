/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import { inject, injectable } from 'inversify';
import { find as findLink } from 'linkifyjs';
import { URL } from 'url';
import * as vscode from 'vscode';
import {
  Configuration,
  DebugByLinkState,
  DebugType,
  readConfig,
} from '../common/contributionUtils';
import { DefaultBrowser, IDefaultBrowserProvider } from '../common/defaultBrowserProvider';
import { DisposableList, IDisposable } from '../common/disposable';
import { once } from '../common/objUtils';
import { ITerminalLinkProvider } from '../common/terminalLinkProvider';
import { isLoopbackIp, isMetaAddress } from '../common/urlUtils';

interface ITerminalLink extends vscode.TerminalLink {
  target: URL;
  workspaceFolder?: number;
}

const enum Protocol {
  Http = 'http:',
  Https = 'https:',
}

@injectable()
export class TerminalLinkHandler implements ITerminalLinkProvider<ITerminalLink>, IDisposable {
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
      vscode.window.registerTerminalLinkProvider(this),
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
  public provideTerminalLinks(context: vscode.TerminalLinkContext): ITerminalLink[] {
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

    for (const link of findLink(context.line, 'url')) {
      let start = -1;
      while ((start = context.line.indexOf(link.value, start + 1)) !== -1) {
        let uri: URL;
        try {
          uri = new URL(link.href);
        } catch {
          continue;
        }

        // hack for https://github.com/Soapbox/linkifyjs/issues/317
        if (
          uri.protocol === Protocol.Http
          && !link.value.startsWith(Protocol.Http)
          && !isLoopbackIp(uri.hostname)
        ) {
          uri.protocol = Protocol.Https;
        }

        if (uri.protocol !== Protocol.Http && uri.protocol !== Protocol.Https) {
          continue;
        }

        links.push({
          startIndex: start,
          length: link.value.length,
          tooltip: l10n.t('Debug URL'),
          target: uri,
          workspaceFolder: getCwd()?.index,
        });
      }
    }

    return links;
  }

  /**
   * @inheritdoc
   */
  public async handleTerminalLink(terminal: ITerminalLink): Promise<void> {
    if (!(await this.handleTerminalLinkInner(terminal))) {
      vscode.env.openExternal(vscode.Uri.parse(terminal.target.toString()));
    }
  }

  /**
   * Launches a browser debug session when a link is clicked from a debug terminal.
   */
  public async handleTerminalLinkInner(terminal: ITerminalLink): Promise<boolean> {
    if (!terminal.target) {
      return false;
    }

    const uri = terminal.target;

    if (vscode.env.uiKind === vscode.UIKind.Web) {
      if (this.notifiedCantOpenOnWeb) {
        return false;
      }

      vscode.window.showInformationMessage(
        l10n.t(
          "We can't launch a browser in debug mode from here. If you want to debug this webpage, open this workspace from VS Code on your desktop.",
        ),
      );

      this.notifiedCantOpenOnWeb = true;
      return false;
    }

    if (isMetaAddress(uri.hostname)) {
      uri.hostname = 'localhost';
    }

    let debugType: DebugType.Chrome | DebugType.Edge = DebugType.Chrome;
    try {
      if ((await this.defaultBrowser.lookup()) === DefaultBrowser.Edge) {
        debugType = DebugType.Edge;
      }
    } catch {
      // ignored
    }

    const cwd = terminal.workspaceFolder !== undefined
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
