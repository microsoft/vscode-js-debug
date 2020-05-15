import { workspace } from 'vscode';
import type { WorkspaceFolder } from 'vscode';

const getPackageManager = (folder: WorkspaceFolder | undefined) => workspace
  .getConfiguration('npm', folder?.uri)
  .get<string>('packageManager', 'npm');

export const getRunScriptCommand = (name: string, folder?: WorkspaceFolder) => {
  return `${getPackageManager(folder)} run ${name}`;
};