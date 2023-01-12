/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as vscode from 'vscode';

/**
 * This file is only included in the extension build, to pull localization from
 * the vscode API. Otherwise, the l10n.t(s file is used.
 */
export const t = vscode.l10n.t;
