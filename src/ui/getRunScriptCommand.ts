/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { commands, WorkspaceFolder } from 'vscode';

/**
 * Gets the package manager the user configured in the folder.
 */
export const getScriptRunner = async (folder: WorkspaceFolder | undefined) => {
  try {
    return await commands.executeCommand('npm.scriptRunner', folder?.uri);
  } catch {
    try {
      return await commands.executeCommand('npm.packageManager', folder?.uri);
    } catch {
      return 'npm';
    }
  }
};

/**
 * Gets a command to run a script
 */
export const getRunScriptCommand = async (name: string, folder?: WorkspaceFolder) => {
  const scriptRunner = await getScriptRunner(folder);
  return `${scriptRunner} ${scriptRunner === 'node' ? '--run' : 'run'} ${name}`;
};
