/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as vscode from 'vscode';
import * as nls from 'vscode-nls';
import { writeConfig, Configuration } from '../common/contributionUtils';

const localize = nls.loadMessageBundle();

export const toggleOnExperiment = async () => {
  await writeConfig(
    vscode.workspace,
    Configuration.UsePreviewDebugger,
    true,
    vscode.ConfigurationTarget.Global,
  );

  await vscode.window.showInformationMessage(
    localize(
      'experimentEnlist',
      'You can turn the new debugger off using the "debug.javascript.usePreview" setting. Please report any problems you run into, thanks for trying it out!',
    ),
  );
};
