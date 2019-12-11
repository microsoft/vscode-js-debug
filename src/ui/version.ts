/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as vscode from 'vscode';

export function checkVersion(version: string): boolean {
  const toNumber = (v: string): number => {
    if (v.includes('-')) v = v.substring(0, v.indexOf('-'));
    const s = v.split('.');
    return +s[0] * 10000 + +s[1] * 100 + +s[2];
  };
  return toNumber(vscode.version) >= toNumber(version);
}
