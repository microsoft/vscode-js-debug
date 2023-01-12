/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as l10nModule from '@vscode/l10n';

if (process.env.L10N_FSPATH_TO_BUNDLE) {
  l10nModule.config({ fsPath: process.env.L10N_FSPATH_TO_BUNDLE });
}

/**
 * This file is only included in subprocesses, to pull localization from
 * the the filesystem. Otherwise, the l10n.extensionOnly.ts file is used.
 */
export const l10n = l10nModule;
