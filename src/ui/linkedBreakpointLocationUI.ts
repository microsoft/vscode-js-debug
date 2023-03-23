/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import { inject, injectable } from 'inversify';
import type * as vscodeType from 'vscode';
import { ExtensionContext, VSCodeApi } from '../ioc-extras';
import { ILinkedBreakpointLocation } from './linkedBreakpointLocation';

const ignoreStorageKey = 'linkBpWarnIgnored';
const docLink =
  'https://code.visualstudio.com/docs/nodejs/nodejs-debugging#_can-i-debug-if-im-using-symlinks';

@injectable()
export class LinkedBreakpointLocationUI implements ILinkedBreakpointLocation {
  private didWarn = this.context.workspaceState.get(ignoreStorageKey, false);

  constructor(
    @inject(VSCodeApi) private readonly vscode: typeof vscodeType,
    @inject(ExtensionContext) private readonly context: vscodeType.ExtensionContext,
  ) {}

  async warn() {
    if (this.didWarn) {
      return;
    }

    this.didWarn = true;
    const readMore = l10n.t('Read More');
    const ignore = l10n.t('Ignore');

    const r = await this.vscode.window.showWarningMessage(
      'It looks like you have symlinked files. You might need to update your configuration to make this work as expected.',
      ignore,
      readMore,
    );

    if (r === ignore) {
      this.context.workspaceState.update(ignoreStorageKey, true);
    } else if (r === readMore) {
      this.vscode.env.openExternal(this.vscode.Uri.parse(docLink));
    }
  }
}
