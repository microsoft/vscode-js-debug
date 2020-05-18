/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { workspace, WorkspaceFolder } from 'vscode';

/**
 * Gets the package manager the user configured in the folder.
 */
const getPackageManager = (folder: WorkspaceFolder | undefined) =>
  workspace.getConfiguration('npm', folder?.uri).get<string>('packageManager', 'npm');

/**
 * Gets a command to run a script
 */
export const getRunScriptCommand = (name: string, folder?: WorkspaceFolder) =>
  `${getPackageManager(folder)} run ${name}`;
