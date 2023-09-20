/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import type * as dwf from '@vscode/dwarf-debugging';
import * as l10n from '@vscode/l10n';
import { inject, injectable } from 'inversify';
import * as vscode from 'vscode';
import { IDwarfModuleProvider } from '../adapter/dwarf/dwarfModuleProvider';
import { ExtensionContext } from '../ioc-extras';

const EXT_ID = 'ms-vscode.wasm-dwarf-debugging';
const NEVER_REMIND = 'dwarf.neverRemind';

@injectable()
export class DwarfModuleProvider implements IDwarfModuleProvider {
  private didPromptForSession = this.context.workspaceState.get(NEVER_REMIND, false);

  constructor(@inject(ExtensionContext) private readonly context: vscode.ExtensionContext) {}

  /** @inheritdoc */
  public async load(): Promise<typeof dwf | undefined> {
    try {
      // for development, use the module to avoid having to install the extension
      return await import('@vscode/dwarf-debugging');
    } catch {
      // fall through
    }

    const ext = vscode.extensions.getExtension<typeof dwf>(EXT_ID);
    if (!ext) {
      return undefined;
    }
    if (!ext.isActive) {
      await ext.activate();
    }

    return ext.exports;
  }

  /** @inheritdoc */
  public async prompt() {
    if (this.didPromptForSession) {
      return;
    }

    this.didPromptForSession = true;

    const yes = l10n.t('Yes');
    const never = l10n.t('Never');
    const response = await vscode.window.showInformationMessage(
      l10n.t({
        message:
          'VS Code can provide better debugging experience for WebAssembly via "DWARF Debugging" extension. Would you like to install it?',
        comment: '"DWARF Debugging" is the extension name and should not be localized.',
      }),
      yes,
      l10n.t('Not Now'),
      never,
    );

    if (response === yes) {
      this.install();
    } else if (response === never) {
      this.context.workspaceState.update(NEVER_REMIND, true);
    }
  }

  private async install() {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: l10n.t('Installing the DWARF debugger...'),
      },
      async () => {
        try {
          await vscode.commands.executeCommand('workbench.extensions.installExtension', EXT_ID);
          vscode.window.showInformationMessage(
            l10n.t(
              'Installation complete! The extension will be used after you restart your debug session.',
            ),
          );
        } catch (e) {
          vscode.window.showErrorMessage(e.message || String(e));
        }
      },
    );
  }
}
