/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

export const IDwarfModuleProvider = Symbol('IDwarfModuleProvider');

export interface IDwarfModuleProvider {
  /**
   * Loads the dwarf module if it exists.
   */
  load(): Promise<typeof import('@vscode/dwarf-debugging') | undefined>;

  /**
   * Prompts the user to install the dwarf module (called if the module is
   * not installed.)
   */
  prompt(): void;
}
