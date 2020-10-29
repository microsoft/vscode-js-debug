/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { commands, WorkspaceFolder } from 'vscode';

/**
 * Gets the package manager the user configured in the folder.
 */
export const getPackageManager = async (folder: WorkspaceFolder | undefined) => {
  try {
    return await commands.executeCommand('npm.packageManager', folder?.uri);
  } catch {
    return 'npm';
  }
};

/**
 * Gets a command to run a script
 */
export const getRunScriptCommand = async (name: string, folder?: WorkspaceFolder) =>
  `${await getPackageManager(folder)} run ${name}`;
