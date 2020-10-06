/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { getSourceSuffix } from '../../adapter/templates';

/**
 * Expression to be evaluated to set that the debugger is successfully attached
 * and ready for extensions to start being debugged.
 *
 * See microsoft/vscode#106698.
 */
export const signalReadyExpr = () => `globalThis.__jsDebugIsReady = true; ` + getSourceSuffix();
