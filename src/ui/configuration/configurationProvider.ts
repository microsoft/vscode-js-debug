/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as vscode from 'vscode';

// Here we create separate sets of interfaces for providing and resolving
// debug configuration.

export interface IDebugConfigurationResolver {
  readonly type: string;

  /**
   * Prevent accidentally having this on a resolver.
   */
  provideDebugConfigurations?: never;

  /**
   * @see DebugConfigurationProvider.resolveDebugConfiguration
   */
  resolveDebugConfiguration: Required<
    vscode.DebugConfigurationProvider['resolveDebugConfiguration']
  >;

  /**
   * @see DebugConfigurationProvider.resolveDebugConfigurationWithSubstitutedVariables
   */
  resolveDebugConfigurationWithSubstitutedVariables?: vscode.DebugConfigurationProvider['resolveDebugConfigurationWithSubstitutedVariables'];
}

export const IDebugConfigurationResolver = Symbol('IDebugConfigurationResolver');

export interface IDebugConfigurationProvider {
  readonly type: string;
  readonly triggerKind: vscode.DebugConfigurationProviderTriggerKind;

  /**
   * @see DebugConfigurationProvider.provideDebugConfigurations
   */
  provideDebugConfigurations: Required<
    vscode.DebugConfigurationProvider['provideDebugConfigurations']
  >;
}

export const IDebugConfigurationProvider = Symbol('IDebugConfigurationProvider');
